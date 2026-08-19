import { Scene } from '@canvai/canvas-core';
import type { Author, ServerMessage } from '@canvai/protocol';
import { AgentLoop } from '../loop.js';
import type { ChatMessage, ChatRequest, ModelClient, StreamChunk, ToolCall } from '../model/types.js';
import type { SessionState } from '../tools/context.js';

/**
 * 脚本化模型：把"模型这一步会调什么工具"写死。
 *
 * 有了它，Agent 的行为（权限、错误恢复、op 分组、事件顺序）可以在
 * 不联网、不花钱、毫秒级的条件下回归。真实模型的不确定性被隔离在这层之外。
 */
export class ScriptedModel implements ModelClient {
  readonly name = 'scripted';
  /** 每次 stream() 调用收到的完整 messages，用来断言上下文布局 */
  readonly seen: ChatMessage[][] = [];
  private i = 0;

  constructor(private readonly steps: Array<{ text?: string; calls?: ToolCall[] }>) {}

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    this.seen.push(structuredClone(req.messages));
    const step = this.steps[this.i++];

    if (!step) {
      yield { kind: 'done', finishReason: 'stop' };
      return;
    }
    if (step.text) {
      // 分片吐出，模拟真实流式
      for (const piece of chunk(step.text, 8)) {
        if (req.signal?.aborted) return;
        yield { kind: 'text', delta: piece };
      }
    }
    if (step.calls && step.calls.length > 0) yield { kind: 'tool_calls', calls: step.calls };
    yield { kind: 'done', finishReason: step.calls ? 'tool_calls' : 'stop' };
  }

  get callCount(): number {
    return this.i;
  }
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

let seq = 0;
export const call = (name: string, args: unknown): ToolCall => ({
  id: `call_${++seq}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

export interface Harness {
  scene: Scene;
  session: SessionState;
  loop: AgentLoop;
  model: ScriptedModel;
  emitted: ServerMessage[];
  /** 按类型取事件 */
  events<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[];
}

export const USER: Author = { id: 'u1', kind: 'user', name: '用户' };

export function makeHarness(
  steps: Array<{ text?: string; calls?: ToolCall[] }>,
  init: {
    scene?: Scene;
    session?: Partial<SessionState>;
    /**
     * 收到 interact_ask_user 就自动replied——不然回合会一直阻塞到 maxMs，
     * 每条这样的用例白等 5 秒。给一个函数可以按问题内容答不同的话。
     */
    autoAnswer?: string | ((question: string) => string);
  } = {},
): Harness {
  const scene = init.scene ?? new Scene();
  const session: SessionState = {
    selection: [],
    viewport: [0, 0, 1440, 900],
    zoom: 1,
    editMode: 'suggest',
    mode: 'assist',
    tutor: null,
    ...init.session,
  };
  const emitted: ServerMessage[] = [];
  const model = new ScriptedModel(steps);
  const loop: AgentLoop = new AgentLoop({
    model,
    scene,
    session,
    emit: (m) => {
      emitted.push(m);
      if (m.t === 'agent.ask' && init.autoAnswer !== undefined) {
        const answer = typeof init.autoAnswer === 'function' ? init.autoAnswer(m.question) : init.autoAnswer;
        // 下一个微任务再答，让 ask 先把 pendingAsk 挂上
        queueMicrotask(() => loop.push({ kind: 'answer', askId: m.askId, answer, at: Date.now() }));
      }
    },
    maxSteps: 8,
    maxMs: 5_000,
  });

  return {
    scene,
    session,
    loop,
    model,
    emitted,
    events: (t) => emitted.filter((m) => m.t === t) as never,
  };
}
