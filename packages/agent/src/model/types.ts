/**
 * 模型层抽象。
 *
 * DeepSeek 是 OpenAI 兼容的，所以这层接口对任何兼容端点都成立——
 * 换 provider 只需换 baseUrl 和 model，不动上面的 Agent Loop。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant 发起的工具调用 */
  tool_calls?: ToolCall[];
  /** role='tool' 时，对应哪次调用 */
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface FunctionSchema {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export type StreamChunk =
  | { kind: 'text'; delta: string }
  /** 思维链（deepseek-reasoner 走这个字段，不进历史） */
  | { kind: 'reasoning'; delta: string }
  | { kind: 'tool_calls'; calls: ToolCall[] }
  | { kind: 'done'; finishReason: string; usage?: Usage };

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** DeepSeek 的前缀缓存命中数——用来验证缓存策略有没有生效 */
  cachedTokens?: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: FunctionSchema[];
  temperature?: number;
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
}

export interface ModelClient {
  readonly name: string;
  stream(req: ChatRequest): AsyncIterable<StreamChunk>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}
