import type { Rect, ServerMessage, ShapeInput } from '@canvai/protocol';
import { toFunctionSchema } from '@canvai/protocol';
import type { ChatMessage, ModelClient, ToolCall } from '../model/types.js';
import { studentPrompt } from './prompt.js';
import { STUDENT_TOOLS } from './tools.js';

/**
 * 学生 Agent 对外界的出口。
 *
 * 抽成接口是为了让它在测试里跑得起来：真实运行时接的是一个 WebSocket 房间客户端，
 * 单测里接的是一个把动作记下来的假对象。
 */
export interface StudentPort {
  /** 主动说话（会唤醒老师） */
  say(text: string): void;
  /** 回答老师的提问 */
  answer(askId: string, text: string): void;
  /** 在画布上画东西，返回画了哪些、落在哪 */
  draw(shapes: ShapeInput[], note?: string): { ids: string[]; region: Rect };
  /** 看画布：返回一段人能读的描述 */
  look(region?: Rect): string;
}

export interface StudentOptions {
  model: ModelClient;
  port: StudentPort;
  /** 人设：这次要扮演什么样的学生 */
  persona: string;
  /** 一次动作里最多几步工具，防止它自己跟自己聊起来 */
  maxSteps?: number;
  /** 每一步的日志，跑演练时用来打转录 */
  onStep?: (step: { tool: string; args: unknown; result?: string }) => void;
}

/** 学生这一次动作干了什么，供演练脚本判定 */
export interface StudentAction {
  steps: number;
  said: string[];
  answered: string[];
  drew: number;
  /** 它自己说这一轮结束了 */
  done: boolean;
}

/**
 * 会做题的学生。
 *
 * 和老师那个 AgentLoop 的关键区别：它是**被动**的。
 * 老师问一句，它答一句；没人问它就不动。这正是要测的那件事——
 * 辅导是不是真的一步都没漏地把球传回来了。
 */
export class StudentAgent {
  private readonly opts: Required<Pick<StudentOptions, 'maxSteps'>> & StudentOptions;
  private history: ChatMessage[] = [];
  /** 还没喂给模型的观察（老师说了什么、判了什么） */
  private inbox: string[] = [];
  private pendingAsk: { askId: string; question: string; options?: string[] } | null = null;

  constructor(options: StudentOptions) {
    this.opts = { maxSteps: 6, ...options };
  }

  get waitingOnQuestion(): boolean {
    return this.pendingAsk !== null;
  }

  /**
   * 收下老师那边发来的一条消息。
   *
   * 只留学生**看得见**的东西：老师说的话、判定、提问、进度清单、模式变化。
   * 工具调用、光标移动这些不进——真实用户也不会逐条读那些。
   */
  observe(msg: ServerMessage): void {
    switch (msg.t) {
      case 'agent.say':
        this.inbox.push(`老师说：${msg.text}`);
        break;
      case 'agent.judge': {
        const label = msg.verdict === 'right' ? '答对了' : msg.verdict === 'partly' ? '对了一半' : '不对';
        this.inbox.push(`老师对你刚才的回答判定「${label}」：${msg.comment}`);
        break;
      }
      case 'agent.ask':
        this.pendingAsk = {
          askId: msg.askId,
          question: msg.question,
          ...(msg.options ? { options: msg.options } : {}),
        };
        this.inbox.push(
          `老师问你：${msg.question}` + (msg.options ? `（可选：${msg.options.join(' / ')}）` : ''),
        );
        break;
      case 'agent.todo':
        if (msg.items.length > 0) {
          this.inbox.push(
            `进度：${msg.items.map((i) => `${i.done ? '✓' : '▢'} ${i.text}`).join('；')}`,
          );
        }
        break;
      case 'session.mode':
        this.inbox.push(msg.note ?? `（模式变成了 ${msg.mode}）`);
        break;
      default:
        break;
    }
  }

  /** 开场：把这次的诉求说出去 */
  async open(request: string): Promise<StudentAction> {
    this.inbox.push(`[你现在要做的事] ${request}`);
    return this.act();
  }

  /**
   * 动一次：把攒下的观察喂给模型，让它决定说什么/答什么/画什么。
   *
   * 没有新观察时直接返回，不白烧一次调用——
   * 学生不会对着屏幕自言自语。
   */
  async act(): Promise<StudentAction> {
    const out: StudentAction = { steps: 0, said: [], answered: [], drew: 0, done: false };
    if (this.inbox.length === 0 && !this.pendingAsk) return out;

    this.history.push({ role: 'user', content: this.inbox.join('\n') });
    this.inbox = [];

    let nudged = false;
    for (let i = 0; i < this.opts.maxSteps; i++) {
      const calls = await this.step();
      out.steps++;

      let stop = calls.length === 0;
      for (const c of calls) {
        const result = this.run(c, out);
        this.history.push({
          role: 'tool',
          tool_call_id: c.id,
          name: c.function.name,
          content: result,
        });
        if (c.function.name === 'student_done') {
          out.done = true;
          stop = true;
        }
      }
      if (!stop) continue;

      /**
       * 要收工了，可它一个字都没说出去——看了眼画布就 student_done，
       * 或者干脆没调工具。老师那边还等着，整场辅导就此卡死。
       *
       * 真实学生不会这样。推一把，只推一次：不是让它"继续思考"，是让它开口。
       */
      const silent = out.said.length === 0 && out.answered.length === 0;
      if (silent && !nudged) {
        nudged = true;
        out.done = false;
        this.history.push({
          role: 'user',
          content:
            '[系统] 你到现在一个字都没说出去，老师那边还等着。' +
            (this.pendingAsk
              ? `用 student_answer 回答「${this.pendingAsk.question}」`
              : '用 student_say 把你要说的话说出来') +
            '，然后再 student_done。',
        });
        continue;
      }
      break;
    }

    return out;
  }

  private async step(): Promise<ToolCall[]> {
    const messages: ChatMessage[] = [
      { role: 'system', content: studentPrompt(this.opts.persona) },
      ...this.history,
    ];

    let text = '';
    let calls: ToolCall[] = [];
    for await (const chunk of this.opts.model.stream({
      messages,
      tools: STUDENT_TOOLS.map((t) => toFunctionSchema(t)),
    })) {
      if (chunk.kind === 'text') text += chunk.delta;
      else if (chunk.kind === 'tool_calls') calls = chunk.calls;
    }

    const assistant: ChatMessage = { role: 'assistant', content: text || null };
    if (calls.length > 0) assistant.tool_calls = calls;
    this.history.push(assistant);
    return calls;
  }

  private run(call: ToolCall, out: StudentAction): string {
    const name = call.function.name;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      // 参数坏了就当空的：学生这边不值得为此专门做一套纠错
    }

    let result: string;
    switch (name) {
      case 'student_look':
        result = this.opts.port.look(args.region as Rect | undefined);
        break;

      case 'student_answer': {
        const text = String(args.text ?? '');
        if (!this.pendingAsk) {
          // 老师没在问就没处可答——退化成主动说一句，别让这一轮空掉
          this.opts.port.say(text);
          out.said.push(text);
          result = '老师现在没有在问你问题，这句话按主动发言送出去了。';
          break;
        }
        this.opts.port.answer(this.pendingAsk.askId, text);
        this.pendingAsk = null;
        out.answered.push(text);
        result = '答案已经交给老师了。';
        break;
      }

      case 'student_say': {
        const text = String(args.text ?? '');
        this.opts.port.say(text);
        out.said.push(text);
        result = '说出去了。';
        break;
      }

      case 'student_draw': {
        const shapes = (args.shapes ?? []) as ShapeInput[];
        const { ids, region } = this.opts.port.draw(shapes, args.note as string | undefined);
        out.drew += ids.length;
        result = `画好了 ${ids.length} 个图元，落在 [${region.map(Math.round).join(',')}]。`;
        break;
      }

      case 'student_done':
        result = '这一轮结束，等老师。';
        break;

      default:
        result = `没有 ${name} 这个工具。你只能用 student_look / student_answer / student_say / student_draw / student_done。`;
    }

    this.opts.onStep?.({ tool: name, args, result });
    return result;
  }
}
