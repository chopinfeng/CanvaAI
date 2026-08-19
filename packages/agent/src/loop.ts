import { nanoid } from 'nanoid';
import type { Scene } from '@canvai/canvas-core';
import type { AgentInputEvent, Author, ServerMessage, ToolResult } from '@canvai/protocol';
import { buildContextHeader, describeDiff } from './context.js';
import { detectTutorIntent } from './intent.js';
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

/** 算"在图上指了东西"的工具。讲题时每一个问题都该挂在其中之一上 */
const POINTING_TOOLS = new Set([
  'canvas_highlight',
  'canvas_spotlight',
  'canvas_zoom_to',
  'canvas_create',
  'canvas_ink',
  'canvas_pointer_move',
]);

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

  /**
   * 回合时限的剩余额度。
   *
   * 计的是 **Agent 自己干活的时间**，不含等用户回答的时间——
   * 挂钟计时会在辅导里造成一个很蠢的后果：学生盯着几何题想两分钟，
   * 回合就超时死了，问题还挂在屏幕上，谁也没说一句话。
   */
  private budgetLeft = 0;
  private budgetTimer: ReturnType<typeof setTimeout> | null = null;
  private budgetArmedAt = 0;
  private timedOut = false;
  /** 回合断掉时，问题还挂在用户屏幕上——他正要答，这时候别插话 */
  private askInterrupted = false;
  /** 本回合已走的步数，和"上一次用户开口时走到第几步" */
  private stepsInTurn = 0;
  private stepFloor = 0;

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
      // 但先过一遍意图：辅导模式下 Agent 大部分时间都停在 interact_ask_user 上，
      // 用户想走的那句话（"先不学了""直接告诉我答案"）多半就打在答题框里。
      // 不在这儿判，它会被当成一句普通回答咽下去，模式一直挂着下不来。
      this.applyIntent([event]);
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
    this.budgetLeft = this.opts.maxMs;
    this.timedOut = false;
    this.askInterrupted = false;
    this.stepsInTurn = 0;
    this.stepFloor = 0;
    this.armBudget(controller);

    this.applyIntent(events);
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
    /** 交回球的提醒只发一次，免得两边互相等着变成死循环 */
    let nudged = false;


    try {
      for (;;) {
        if (controller.signal.aborted) {
          reason = this.timedOut ? 'timeout' : 'aborted';
          break;
        }
        /**
         * 步数上限是防死循环的，不是给辅导设的课时。
         *
         * interact_ask_user 会阻塞回合，所以一整场辅导是**一个回合**：
         * 问一次、判一次、再问一次，十来步就撞上限被掐断，
         * 学生正答得好好的，AI 忽然收摊。用户开口过就说明这不是空转，
         * 所以每次他回答之后，额度从头再算。
         */
        if (this.stepsInTurn - this.stepFloor >= this.opts.maxSteps) {
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
        this.stepsInTurn = steps;
        fullText += out.text;

        if (out.calls.length === 0) {
          // 辅导里"没调工具就结束"= 球断在这儿了：用户等着被问，
          // 而模型以为自己讲完了。补一句系统提醒，再给它一次机会。
          const nudge = nudged ? null : this.tutorHandBack();
          if (nudge) {
            nudged = true;
            this.history.push({ role: 'user', content: nudge });
            continue;
          }
          break;
        }

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
      this.disarmBudget();
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

    this.announceTutorPause();

    this.opts.emit({ t: 'agent.turn.end', turnId, reason });
    return { turnId, steps, reason, text: fullText, toolCalls, ...(error ? { error } : {}) };
  }

  /**
   * 用户说「给我讲这道题」时自动进入辅导模式，说「直接告诉我答案」时退出。
   *
   * 不这么做的话，辅导模式等于不存在——它的开关在面板角落，
   * 而用户的自然表达就是那句话，没人会先去找开关。
   */
  private applyIntent(events: AgentInputEvent[]): void {
    const session = this.opts.session;
    for (const e of events) {
      const said = e.kind === 'text' || e.kind === 'speech' ? e.text : e.kind === 'answer' ? e.answer : null;
      if (said === null) continue;
      const intent = detectTutorIntent(said);
      if (!intent) continue;

      if (intent === 'enter') {
        // 只有主动开口才算"想被教"。答题框里的"我不会"是对某个问题的回答，
        // 不是要切模式——普通模式下 Agent 也会提问，那时把他拖进辅导纯属误伤。
        if (e.kind === 'answer') continue;
        // 已经在辅导里就什么都不做：「我不会」这类话也命中 enter，
        // 而它在辅导中途是再正常不过的一句，拿它重置进度会把讲过的全丢掉。
        if (session.mode === 'tutor') continue;
        session.mode = 'tutor';
        session.tutor = { goal: said.trim().slice(0, 120), outline: [], startedTurn: this.turnNo, pending: null, rightSince: 0, markedSinceAsk: false };
        this.opts.emit({ t: 'session.mode', mode: 'tutor', auto: true });
        continue;
      }

      // exit / switch：都是离开辅导，但离开的理由不一样，说给用户的话也不该一样
      if (session.mode !== 'tutor') continue;
      const left = session.tutor?.outline.filter((i) => !i.done) ?? [];
      session.mode = 'assist';
      session.tutor = null;
      this.opts.emit({ t: 'agent.todo', items: [] });
      this.opts.emit({
        t: 'session.mode',
        mode: 'assist',
        auto: true,
        note:
          intent === 'exit'
            ? '（已切回协作模式：直接给你结果。）'
            : left.length > 0
              ? `（先放下这道题——还剩 ${left.length} 个小问没做完，想接着学随时说。）`
              : '（已退出辅导，去做新任务。）',
      });
    }
  }

  /**
   * 辅导停在半路时，明说一声停在哪儿。
   *
   * 题没讲完就停下来，本身是允许的（超时、报错、撞步数上限、模型自己不问了），
   * 不允许的是**一声不吭地停**——用户等在那里，不知道是该答什么，
   * 还是这次已经结束了。所以由主循环兜底说这句话，不依赖模型配合。
   *
   * 三种情况不说：不在辅导里、问题还挂在他屏幕上（他正要答）、
   * 队列里还有事件（下一个回合马上就起来）。
   */
  private announceTutorPause(): void {
    const t = this.opts.session.tutor;
    if (this.opts.session.mode !== 'tutor' || !t) return;
    if (this.askInterrupted || this.queue.length > 0) return;

    const left = t.outline.filter((i) => !i.done);
    if (t.outline.length > 0 && left.length === 0) return; // 都做完了，收尾的话 tutor_finish 会说

    const where =
      left.length > 0
        ? `还剩 ${left.length} 个没做完，卡在「${left[0]!.text}」`
        : '这道题还没开始拆';
    this.opts.emit({
      t: 'agent.say',
      text: `（这次辅导先停在这里——${where}。想接着学，说一声就行。）`,
      interruptible: true,
    });
  }

  /* ---- 回合时限：只在 Agent 自己干活时走表 ---- */

  private armBudget(controller: AbortController): void {
    if (this.budgetTimer) return;
    this.budgetArmedAt = Date.now();
    this.budgetTimer = setTimeout(() => {
      this.timedOut = true;
      controller.abort();
    }, Math.max(1, this.budgetLeft));
  }

  private disarmBudget(): void {
    if (!this.budgetTimer) return;
    clearTimeout(this.budgetTimer);
    this.budgetTimer = null;
    this.budgetLeft -= Date.now() - this.budgetArmedAt;
  }

  /**
   * 辅导这一轮该不该被放走？不该的话，返回要塞给模型的那句提醒。
   *
   * 用户的诉求很简单：他问的题没讲完，这次辅导就不能算结束。
   * 光靠提示词压不住——模型讲完一半、用户说声"懂了"，它就顺势收尾了。
   * 所以在回合出口这里拦一道：辅导中、账上还有没解决的小问、这一轮又没向他提问，
   * 就不放行，把还剩什么摆回它面前。
   */
  private tutorHandBack(): string | null {
    const session = this.opts.session;
    if (session.mode !== 'tutor' || !session.tutor) return null;
    const t = session.tutor;

    // 「这一轮问过了就放行」是错的：interact_ask_user 会阻塞回合，
    // 所以回合走到这里时，问过 = 他早就答完了。问了、他答了、然后一声不吭收工，
    // 恰恰是最常见的断球方式。
    if (t.pending) {
      return (
        `[系统] 用户回答了「${t.pending.answer}」，你到现在也没说这答案对不对，就把这一轮结束了。` +
        `他不知道自己刚才那步站不站得住，接着往下走就是蒙的。` +
        `先用 tutor_judge 给个判定（right / partly / wrong 加一句为什么），再提下一个问题。`
      );
    }

    if (t.outline.length === 0) {
      return (
        `[系统] 辅导刚开始，你还没拆题——那这次讲到哪儿算完就没人说得清。` +
        `先用 tutor_plan 把「${t.goal}」拆成用户要逐个攻克的小问（第 (1)(2) 问至少各算一条），` +
        `再用 interact_ask_user 就第一个小问提一个他答得上来的问题，然后结束本回合。`
      );
    }

    const left = t.outline.filter((i) => !i.done);
    if (left.length === 0) {
      return '[系统] 小问都解决了，这次辅导可以收尾了。用 tutor_finish 提交一两句回顾（说他自己走通的思路，不是复述答案）。';
    }

    return (
      `[系统] 这一轮你没有向用户提问，球断在这里了——他在等你，你以为讲完了。` +
      `账上还剩 ${left.length} 个小问没解决：${left.map((i) => i.text).join('；')}。` +
      `就「${left[0]!.text}」用 interact_ask_user 提一个他答得上来的问题，然后结束本回合。` +
      `如果他刚才其实已经自己算出来了，先用 tutor_plan 把那条标成 done。`
    );
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

    const tutor = this.opts.session.mode === 'tutor';
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
          // 辅导模式下先攒着不发：这一步是不是"推理"要等本步结束才知道，
          // 而推理里带着答案。见下面 step 收尾处的说明。
          if (!tutor) this.opts.emit({ t: 'agent.text', turnId, step, delta: chunk.delta });
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

    /**
     * 辅导模式：把"过程"整个扣下，只放行最后的答复。
     *
     * 普通模式下中间步骤的正文会折进「思考过程」，用户想看可以展开——
     * 但辅导模式里那段推理**就是答案本身**（"…解得 x=5/3"），
     * 展开一次这一整套引导就白做了。所以干脆不下发：
     * 客户端拿不到，也就没有可展开的东西。
     *
     * 代价是最终答复不再逐字流式显示。辅导模式每轮只说两句，这个代价可以接受。
     */
    if (tutor) {
      if (calls.length === 0 && text.trim()) {
        this.opts.emit({ t: 'agent.text', turnId, step, delta: text });
      }
    }

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
      if (POINTING_TOOLS.has(name) && this.opts.session.tutor) {
        this.opts.session.tutor.markedSinceAsk = true;
      }
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

    // 他想多久是他的事，不占回合额度
    this.disarmBudget();

    return new Promise<string>((resolve) => {
      const onAbort = () => {
        this.pendingAsk = null;
        this.askInterrupted = true;
        this.opts.emit({ t: 'agent.ask.done', askId });
        // 中断不算"答过"：没答的东西没什么可判定的
        resolve('[用户没有回答，操作被中断]');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingAsk = {
        askId,
        resolve: (answer) => {
          signal.removeEventListener('abort', onAbort);
          // 房间里别的客户端也得把提问卡收掉
          this.opts.emit({ t: 'agent.ask.done', askId });
          if (this.controller) this.armBudget(this.controller);
          // 他开口了，这一轮不是空转——步数额度重新起算
          this.stepFloor = this.stepsInTurn;
          // 挂上"待判定"。清它的只有 tutor_judge——在那之前不许问下一个问题。
          if (this.opts.session.mode === 'tutor' && this.opts.session.tutor) {
            this.opts.session.tutor.pending = { question, answer };
            // 下一个问题要重新在图上指一次，上一轮点亮的地方不算数
            this.opts.session.tutor.markedSinceAsk = false;
          }
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
