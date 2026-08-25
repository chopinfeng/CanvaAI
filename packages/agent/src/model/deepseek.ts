import type { ChatRequest, ModelClient, StreamChunk, ToolCall, Usage } from './types.js';
import { ModelError } from './types.js';

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  /** 深度推理用的模型，交给 reason_deep 工具 */
  reasonerModel?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * 单次回复的 token 上限——**推理模型的思维链也算在这里面**。
   *
   * 真机录像复现过：辅导一道二阶非齐次微分方程时，讲到系数匹配那步，
   * 思维链自己就把默认的 4096 花光了，回来的是"没有工具调用、
   * 也没有正文"——表现成"模型卡住了"，一场里发生了 5 次，其中一次
   * 连着好几轮都翻不过去，直到录像脚本自己 20 分钟的外部兜底把
   * 整场辅导硬掐断。跟 vlm.maxTokens 是同一个坑（那边的注释写过：
   * "早先写死 800，思考完就没预算了，返回一截 12 个字符的碎片"）——
   * 这里同样是把模型的嘴捂上了，不是它不会。
   */
  maxTokens?: number;
}

/**
 * DeepSeek / 任意 OpenAI 兼容端点的流式客户端。
 *
 * 不依赖 openai SDK：SSE 解析本身很简单，自己实现能精确控制
 * tool_calls 分片的拼装和中断行为——这两件事是 Agent Loop 的地基。
 */
/**
 * 把工具的 JSON Schema 规整成各家都收的形状。
 *
 * 起因：元组式的 `items`（`items: [{type:'number'}, ...]`，JSON Schema
 * draft-7 用它表达定长数组）DeepSeek 收，OpenRouter 上的 stealth/ox-alpha
 * 直接回 400，而且只说一句 "Provider returned error"——不告诉你是哪个字段。
 * 光是定位到 student_look.region 这一个字段就花了一轮二分。
 *
 * 转成单 schema 形式（2020-12 里元组该用 prefixItems，但支持面更窄）。
 * minItems/maxItems 留着，长度约束不丢；丢掉的只是"第几个元素是什么类型"，
 * 而这些位置本来就全是同一种类型（坐标、边界框）。
 *
 * 放在客户端而不是 schema 定义处：这是端点的口味问题，不是我们的 schema 有错。
 * 写死在定义里的话，换回 DeepSeek 就白白损失了精度。
 */
/* ------------------------------------------------------------------ *
 * 换端点时的取证开关
 *
 * 上游出问题时给的信息经常约等于没有：OpenRouter 上 stealth/ox-alpha 的
 * 400 只回一句 "Provider returned error"，不说是哪个字段；而 tool_call 的
 * index 冲突干脆连错误都不报，只是"产出了一千多个 token 然后什么都没发生"。
 * 这两个开关是那两次排查里真正起作用的东西，所以留着。
 *
 *   LLM_DUMP=/tmp/req.json       原样请求体（key 在 header 里，不会落进来）
 *   LLM_DUMP_RES=/tmp/res.jsonl  每个流式分片一行
 *
 * 默认全关。开着会把对话内容写到磁盘，别在生产上开。
 * ------------------------------------------------------------------ */

function dumpRequest(body: string): void {
  const to = process.env.LLM_DUMP;
  if (!to) return;
  void import('node:fs').then((fs) => fs.writeFileSync(to, body));
}

function dumpDelta(delta: unknown): void {
  const to = process.env.LLM_DUMP_RES;
  if (!to) return;
  void import('node:fs').then((fs) => fs.appendFileSync(to, JSON.stringify(delta) + '\n'));
}

/** 流式下发的 tool_call 分片 */
export interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * 把分片拼回完整的工具调用。
 *
 * 不能只按 index 拼：stealth/ox-alpha 一轮里发两个工具调用时，**两个都标 index 0**。
 * 只认 index 的话，第二个调用的 arguments 会被接到第一个后面，拼成
 * `{"limit":30}{"detail":"full",…}`——不是合法 JSON，于是整轮工具一个都没执行。
 * 表面症状是"模型产出了一千多个 token，然后什么都没发生"，日志里连报错都没有。
 *
 * 所以：带了新 id 的分片就是一个新调用，不管它的 index 是几。
 * 按到达顺序返回，不再靠 index 排序——index 本来就不可信了。
 */
export function mergeToolCallDeltas(frames: Iterable<ToolCallDelta[]>): ToolCall[] {
  const calls: ToolCall[] = [];
  const slot = new Map<number, number>(); // index → calls 里的位置

  for (const frame of frames) {
    for (const tc of frame) {
      const idx = tc.index ?? 0;
      const at = slot.get(idx);
      const cur = at === undefined ? undefined : calls[at];

      // 只有"接着拼同一个"的分片才不带 id
      if (cur === undefined || (tc.id !== undefined && tc.id !== cur.id)) {
        calls.push({
          id: tc.id ?? `call_${calls.length}`,
          type: 'function' as const,
          function: { name: '', arguments: '' },
        });
        slot.set(idx, calls.length - 1);
      }

      const target = calls[slot.get(idx)!]!;
      if (tc.function?.name) target.function.name += tc.function.name;
      if (tc.function?.arguments) target.function.arguments += tc.function.arguments;
    }
  }
  return calls;
}

export function compatSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compatSchema);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'items' && Array.isArray(v)) {
      const parts = v as Array<Record<string, unknown>>;
      const types = new Set(parts.map((p) => p?.type));
      // 元素类型一致（坐标数组的常态）就保留类型，否则只能放宽成"任意"
      out[k] = types.size === 1 ? compatSchema(parts[0]) : {};
      continue;
    }
    out[k] = compatSchema(v);
  }
  return out;
}

export class DeepSeekClient implements ModelClient {
  readonly name = 'deepseek';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly model: string;
  readonly reasonerModel: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxTokens: number;

  constructor(opts: DeepSeekOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.model = opts.model ?? 'deepseek-chat';
    this.reasonerModel = opts.reasonerModel ?? 'deepseek-reasoner';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.maxTokens = opts.maxTokens ?? 8192;
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    let attempt = 0;
    for (;;) {
      try {
        yield* this.streamOnce(req);
        return;
      } catch (e) {
        const isModelErr = e instanceof ModelError;
        const retryable = isModelErr && (e as ModelError).retryable;
        // 用户主动中断不重试
        if (req.signal?.aborted) throw e;
        if (!retryable || attempt >= this.maxRetries) throw e;
        attempt++;
        await sleep(400 * 2 ** attempt);
      }
    }
  }

  private async *streamOnce(req: ChatRequest): AsyncIterable<StreamChunk> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const body = JSON.stringify({
          model: req.model ?? this.model,
          messages: req.messages,
          ...(req.tools && req.tools.length > 0
            ? { tools: compatSchema(req.tools) as typeof req.tools, tool_choice: 'auto' }
            : {}),
          temperature: req.temperature ?? 0.3,
          max_tokens: req.maxTokens ?? this.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
      });

      dumpRequest(body);

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw new ModelError(
          `DeepSeek ${res.status}: ${body.slice(0, 300)}`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }

      /** tool_call 分片，攒齐了在 mergeToolCallDeltas 里拼 */
      const frames: ToolCallDelta[][] = [];
      let finishReason = 'stop';
      let usage: Usage | undefined;

      for await (const data of sseLines(res.body)) {
        if (data === '[DONE]') break;

        let json: DeepSeekChunk;
        try {
          json = JSON.parse(data) as DeepSeekChunk;
        } catch {
          continue;
        }

        if (json.usage) {
          usage = {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            cachedTokens: json.usage.prompt_cache_hit_tokens,
          };
        }

        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        dumpDelta(delta);

        // reasoning_content 是 DeepSeek 的字段名，OpenRouter 上叫 reasoning。
        // 只认一个的话，换端点之后思维链会静悄悄地不见——不报错，就是没了。
        const cot = delta.reasoning_content ?? delta.reasoning;
        if (cot) yield { kind: 'reasoning', delta: cot };
        if (delta.content) yield { kind: 'text', delta: delta.content };

        if (delta.tool_calls?.length) frames.push(delta.tool_calls);
      }

      const calls = mergeToolCallDeltas(frames);
      if (calls.length > 0) yield { kind: 'tool_calls', calls };
      yield { kind: 'done', finishReason, ...(usage ? { usage } : {}) };
    } catch (e) {
      if (e instanceof ModelError) throw e;
      if ((e as Error).name === 'AbortError') {
        throw new ModelError(req.signal?.aborted ? '用户中断' : '请求超时', undefined, !req.signal?.aborted);
      }
      throw new ModelError(`网络错误: ${(e as Error).message}`, undefined, true);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/* ------------------------------------------------------------------ *
 * SSE 解析
 * ------------------------------------------------------------------ */

async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DeepSeekChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
  };
}
