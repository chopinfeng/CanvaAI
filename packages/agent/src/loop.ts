import { nanoid } from 'nanoid';
import type { Scene } from '@canvai/canvas-core';
import type { AgentInputEvent, Author, ServerMessage, ToolResult } from '@canvai/protocol';
import { buildContextHeader, describeDiff } from './context.js';
import { extractLeakedCalls, hasLeakedCalls } from './model/leaked-calls.js';
import type { ChatMessage, ModelClient, ToolCall, Usage } from './model/types.js';
import { ModelError } from './model/types.js';
import { SYSTEM_PROMPT, TUTOR_ADDENDUM } from './prompt.js';
import type { AssetStore, Rasterizer, SessionState, ToolContext, VisionProvider } from './tools/context.js';
import { ToolRegistry } from './tools/registry.js';

export interface AgentLoopOptions {
  model: ModelClient;
  scene: Scene;
  session: SessionState;
  emit: (msg: ServerMessage) => void;
  registry?: ToolRegistry;
  author?: Author;
  systemPrompt?: string;
  /** 单回合最多几步工具，防止死循环 */
  maxSteps?: number;
  /** 单回合墙钟上限 */
  maxMs?: number;
  vision?: VisionProvider;
  rasterizer?: Rasterizer;
  assets?: AssetStore;
  onUsage?: (usage: Usage) => void;
}

export interface TurnResult {
  turnId: string;
  steps: number;
  reason: 'done' | 'aborted' | 'max_steps' | 'timeout' | 'error';
  text: string;
  toolCalls: number;
  error?: string;
}

const DEFAULT_AUTHOR: Author = { id: 'agent', kind: 'ai', name: 'AI' };

/**
 * Agent 主循环。
 *
 * 一次 turn = 一次模型流式请求 + 若干轮"工具调用 → 观察 → 再请求"，
 * 直到模型不再调工具、或撞到步数/时间上限、或被用户打断。
 *
 * 事件（说话、画画、选中）统一进队列；一个 turn 跑着的时候来了新事件，
 * 会中断当前 turn 并把新事件带进下一轮 —— 用户永远优先。
 */
export class AgentLoop {
  private readonly opts: Required<Pick<AgentLoopOptions, 'maxSteps' | 'maxMs'>> & AgentLoopOptions;
  private readonly registry: ToolRegistry;
  private readonly author: Author;

  /** append-only：历史一旦写入就不改写，前缀缓存才有意义 */
  private history: ChatMessage[] = [];
  private queue: AgentInputEvent[] = [];
  private running = false;
  private controller: AbortController | null = null;
  private turnNo = 0;
  private lastActions: string[] = [];
  private pendingAsk: { askId: string; resolve: (answer: string) => void } | null = null;

  constructor(options: AgentLoopOptions) {
    this.opts = { maxSteps: 12, maxMs: 90_000, ...options };
    this.registry = options.registry ?? new ToolRegistry();
    this.author = options.author ?? DEFAULT_AUTHOR;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /* ---------------------------------------------------------------- *
   * 事件入口
   * ---------------------------------------------------------------- */

  /** 用户事件入队；如果当前有 turn 在跑，打断它——用户优先 */
  push(event: AgentInputEvent): void {
    // 用户回答问题不算打断，是当前 turn 在等的东西
    if (event.kind === 'answer' && this.pendingAsk) {
      const ask = this.pendingAsk;
      this.pendingAsk = null;
      ask.resolve(event.answer);
      return;
    }
    this.queue.push(event);
    if (this.running) this.abort();
  }

  abort(): void {
    this.controller?.abort();
  }

  /** 把队列里的事件跑成一个 turn；队列空则返回 null */
  async tick(): Promise<TurnResult | null> {
    if (this.running) return null;
    const events = this.queue.splice(0, this.queue.length);
    if (events.length === 0) return null;
    return this.runTurn(events);
  }

  /** 持续消费队列直到空。服务端在收到用户事件后调用。 */
  async drain(): Promise<void> {
    for (;;) {
      const r = await this.tick();
      if (!r) return;
    }
  }

  /* ---------------------------------------------------------------- *
   * 一个 turn
   * ---------------------------------------------------------------- */

  private async runTurn(events: AgentInputEvent[]): Promise<TurnResult> {
    this.running = true;
    this.turnNo++;
    const turnId = `t_${nanoid(8)}`;
    const controller = new AbortController();
    this.controller = controller;
    const deadline = setTimeout(() => controller.abort(), this.opts.maxMs);
    const startedAt = Date.now();

    this.opts.emit({ t: 'agent.turn.start', turnId });

    // Context Header 拼在本轮用户消息里 —— 永远是序列的最后一条
    const header = buildContextHeader({
      scene: this.opts.scene,
      session: this.opts.session,
      events,
      turnNo: this.turnNo,
      lastActions: this.lastActions,
    });
    this.history.push({ role: 'user', content: header });

    const recentOpIds: string[] = [];
    const ctx: ToolContext = {
      scene: this.opts.scene,
      author: this.author,
      session: this.opts.session,
      signal: controller.signal,
      emit: this.opts.emit,
      ask: (question, options) => this.askUser(question, options, controller.signal),
      recentOpIds,
      ...(this.opts.vision ? { vision: this.opts.vision } : {}),
      ...(this.opts.rasterizer ? { rasterizer: this.opts.rasterizer } : {}),
      ...(this.opts.assets ? { assets: this.opts.assets } : {}),
    };

    let steps = 0;
    let toolCalls = 0;
    let fullText = '';
    let reason: TurnResult['reason'] = 'done';
    let error: string | undefined;
    /** 同类工具连续失败计数，撞到 3 就停手，避免烧 token 空转 */
    const failStreak = new Map<string, number>();

    try {
      for (;;) {
        if (controller.signal.aborted) {
          reason = Date.now() - startedAt >= this.opts.maxMs ? 'timeout' : 'aborted';
          break;
        }
        if (steps >= this.opts.maxSteps) {
          reason = 'max_steps';
          this.history.push({
            role: 'user',
            content: `[系统] 本回合工具调用已达上限（${this.opts.maxSteps} 步）。请用 interact_say 向用户汇报当前进度和你打算怎么继续，然后结束本回合。`,
          });
          // 再跑一轮让它有机会说话，但不给工具，避免继续调用
          const closing = await this.streamOnce(turnId, controller.signal, false, steps);
          fullText += closing.text;
          break;
        }

        const out = await this.streamOnce(turnId, controller.signal, true, steps);
        steps++;
        fullText += out.text;

        if (out.calls.length === 0) break;

        toolCalls += out.calls.length;
        await this.executeCalls(out.calls, ctx, turnId, failStreak);

        if (failStreak.size > 0 && [...failStreak.values()].some((n) => n >= 3)) {
          this.history.push({
            role: 'user',
            content:
              '[系统] 你在同一个工具上连续失败了 3 次。别再重试了——换个思路，或者用 interact_say 告诉用户你卡在哪、需要什么。',
          });
          failStreak.clear();
        }
      }
    } catch (e) {
      if (controller.signal.aborted) {
        reason = 'aborted';
      } else {
        reason = 'error';
        error = e instanceof ModelError ? e.message : (e as Error).message;
        this.opts.emit({ t: 'error', message: '模型调用失败', detail: error });
      }
    } finally {
      clearTimeout(deadline);
      this.running = false;
      this.controller = null;
      this.pendingAsk = null;
    }

    // 记住这一轮做了什么，下一轮的 header 会带上
    if (recentOpIds.length > 0) {
      const created: string[] = [];
      for (const s of this.opts.scene.all()) if (recentOpIds.includes(s.opId)) created.push(s.id);
      const desc = describeDiff(this.opts.scene, created, [], []);
      if (desc) this.lastActions.push(desc);
      if (this.lastActions.length > 5) this.lastActions = this.lastActions.slice(-5);
    }

    this.opts.emit({ t: 'agent.turn.end', turnId, reason });
    return { turnId, steps, reason, text: fullText, toolCalls, ...(error ? { error } : {}) };
  }

  /**
   * 辅导模式把 TUTOR_ADDENDUM 接在稳定前缀后面。
   * 会话中途切模式会让前缀缓存失效一次——换取行为正确，这个代价值得。
   */
  private systemPrompt(): string {
    const base = this.opts.systemPrompt ?? SYSTEM_PROMPT;
    return this.opts.session.mode === 'tutor' ? base + TUTOR_ADDENDUM : base;
  }

  /* ---------------------------------------------------------------- *
   * 一次模型流式请求
   * ---------------------------------------------------------------- */

  private async streamOnce(
    turnId: string,
    signal: AbortSignal,
    withTools: boolean,
    step: number,
  ): Promise<{ text: string; calls: ToolCall[] }> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.systemPrompt() },
      ...this.history,
    ];

    let text = '';
    let calls: ToolCall[] = [];

    const stream = this.opts.model.stream({
      messages,
      ...(withTools ? { tools: this.registry.functionSchemas() } : {}),
      signal,
    });

    for await (const chunk of stream) {
      switch (chunk.kind) {
        case 'text':
          text += chunk.delta;
          this.opts.emit({ t: 'agent.text', turnId, step, delta: chunk.delta });
          break;
        case 'reasoning':
          // 思维链不进历史：它不该污染下一轮的上下文，也不该击穿缓存
          break;
        case 'tool_calls':
          calls = chunk.calls;
          break;
        case 'done':
          if (chunk.usage) this.opts.onUsage?.(chunk.usage);
          break;
      }
    }

    // 模型偶尔不走 tool_calls 字段，把调用当正文写出来。捞回来，
    // 否则这次调用等于没发生（用户该听到的话丢了），标记还会原样显示出去。
    if (calls.length === 0 && hasLeakedCalls(text)) {
      const recovered = extractLeakedCalls(text, `${turnId}_s${step}`);
      if (recovered.calls.length > 0) {
        calls = recovered.calls;
        text = recovered.text;
        this.opts.emit({ t: 'agent.status', text: '（模型把工具调用写成了正文，已自动还原）' });
      } else if (recovered.unparsed) {
        text = recovered.text;
        this.history.push({
          role: 'user',
          content:
            '[系统] 你刚才把工具调用写成了正文里的标记，那样不会被执行。请用标准的 function calling 通道重新发起调用。',
        });
      }
    }

    const assistant: ChatMessage = { role: 'assistant', content: text || null };
    if (calls.length > 0) assistant.tool_calls = calls;
    this.history.push(assistant);

    this.opts.emit({ t: 'agent.step', turnId, step, hadTools: calls.length > 0 });

    return { text, calls };
  }

  /* ---------------------------------------------------------------- *
   * 执行工具
   *
   * 只读工具并行跑；写工具串行 —— 写操作的顺序会影响 z 序和绑定结果，
   * 并行执行会让画布状态不可复现。
   * ---------------------------------------------------------------- */

  private async executeCalls(
    calls: ToolCall[],
    ctx: ToolContext,
    turnId: string,
    failStreak: Map<string, number>,
  ): Promise<void> {
    const readonly = calls.filter((c) => this.registry.isReadonly(c.function.name));
    const writes = calls.filter((c) => !this.registry.isReadonly(c.function.name));

    const results = new Map<string, ToolResult>();

    await Promise.all(
      readonly.map(async (c) => {
        results.set(c.id, await this.runOne(c, ctx, turnId, failStreak));
      }),
    );

    for (const c of writes) {
      if (ctx.signal.aborted) break;
      results.set(c.id, await this.runOne(c, ctx, turnId, failStreak));
    }

    // 按模型给出的原始顺序回灌观察结果
    for (const c of calls) {
      const r = results.get(c.id) ?? {
        ok: false as const,
        error: '未执行（回合被中断）',
        hint: '用户打断了操作，不用重试这一步。',
      };
      this.history.push({
        role: 'tool',
        tool_call_id: c.id,
        name: c.function.name,
        content: JSON.stringify(r),
      });
    }
  }

  private async runOne(
    call: ToolCall,
    ctx: ToolContext,
    turnId: string,
    failStreak: Map<string, number>,
  ): Promise<ToolResult> {
    const name = call.function.name;
    const startedAt = Date.now();

    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      args = call.function.arguments;
    }

    this.opts.emit({
      t: 'agent.tool',
      turnId,
      call: { id: call.id, name, args, state: 'running' },
    });

    const result = await this.registry.execute(name, call.function.arguments, ctx);
    const ms = Date.now() - startedAt;

    if (result.ok) {
      failStreak.delete(name);
      this.opts.emit({
        t: 'agent.tool',
        turnId,
        call: {
          id: call.id,
          name,
          args,
          state: 'ok',
          ms,
          ...(result.diff ? { diff: result.diff } : {}),
          ...(typeof (result.data as { summary?: string })?.summary === 'string'
            ? { summary: (result.data as { summary: string }).summary }
            : {}),
        },
      });
    } else {
      failStreak.set(name, (failStreak.get(name) ?? 0) + 1);
      this.opts.emit({
        t: 'agent.tool',
        turnId,
        call: { id: call.id, name, args, state: 'error', ms, error: result.error },
      });
    }

    return result;
  }

  /* ---------------------------------------------------------------- *
   * interact_ask_user：阻塞当前 turn 等用户回答
   * ---------------------------------------------------------------- */

  private askUser(question: string, options: string[] | undefined, signal: AbortSignal): Promise<string> {
    const askId = `ask_${nanoid(6)}`;
    this.opts.emit({ t: 'agent.ask', askId, question, ...(options ? { options } : {}) });

    return new Promise<string>((resolve) => {
      const onAbort = () => {
        this.pendingAsk = null;
        resolve('[用户没有回答，操作被中断]');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingAsk = {
        askId,
        resolve: (answer) => {
          signal.removeEventListener('abort', onAbort);
          resolve(answer);
        },
      };
    });
  }

  /* ---------------------------------------------------------------- *
   * 调试/测试用
   * ---------------------------------------------------------------- */

  getHistory(): readonly ChatMessage[] {
    return this.history;
  }

  resetHistory(): void {
    this.history = [];
    this.turnNo = 0;
    this.lastActions = [];
  }
}
