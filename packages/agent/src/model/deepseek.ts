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
}

/**
 * DeepSeek / 任意 OpenAI 兼容端点的流式客户端。
 *
 * 不依赖 openai SDK：SSE 解析本身很简单，自己实现能精确控制
 * tool_calls 分片的拼装和中断行为——这两件事是 Agent Loop 的地基。
 */
export class DeepSeekClient implements ModelClient {
  readonly name = 'deepseek';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly model: string;
  readonly reasonerModel: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: DeepSeekOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
    this.model = opts.model ?? 'deepseek-chat';
    this.reasonerModel = opts.reasonerModel ?? 'deepseek-reasoner';
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.maxRetries = opts.maxRetries ?? 2;
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
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model ?? this.model,
          messages: req.messages,
          ...(req.tools && req.tools.length > 0 ? { tools: req.tools, tool_choice: 'auto' } : {}),
          temperature: req.temperature ?? 0.3,
          max_tokens: req.maxTokens ?? 4096,
          stream: true,
          stream_options: { include_usage: true },
        }),
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

      /** tool_calls 是按 index 分片流式下发的，必须自己拼 */
      const pending = new Map<number, ToolCall>();
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

        if (delta.reasoning_content) yield { kind: 'reasoning', delta: delta.reasoning_content };
        if (delta.content) yield { kind: 'text', delta: delta.content };

        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = pending.get(idx) ?? {
            id: tc.id ?? `call_${idx}`,
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          pending.set(idx, cur);
        }
      }

      if (pending.size > 0) {
        const calls = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
        yield { kind: 'tool_calls', calls };
      }
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
