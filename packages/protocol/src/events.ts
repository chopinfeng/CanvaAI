import { z } from 'zod';
import { PointSchema, RectSchema, SceneDiffSchema } from './shape.js';

/* ------------------------------------------------------------------ *
 * WS 分帧
 *
 * 单条 WebSocket 多路复用。每帧首字节是 tag：
 *   0x00 JSON 控制消息（下面的 schema）
 *   0x01 Yjs 文档同步
 *   0x02 Yjs awareness（光标/选区/状态）
 *   0x03 音频 PCM（M4）
 * ------------------------------------------------------------------ */

export const FrameTag = {
  Control: 0x00,
  Sync: 0x01,
  Awareness: 0x02,
  Audio: 0x03,
} as const;
export type FrameTagValue = (typeof FrameTag)[keyof typeof FrameTag];

export function encodeFrame(tag: FrameTagValue, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

export function decodeFrame(data: Uint8Array): { tag: number; payload: Uint8Array } {
  return { tag: data[0] ?? -1, payload: data.subarray(1) };
}

/* ------------------------------------------------------------------ *
 * 客户端 → 服务端
 * ------------------------------------------------------------------ */

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('join'),
    roomId: z.string(),
    user: z.object({ id: z.string(), name: z.string(), color: z.string() }),
  }),

  /** 用户输入文字 */
  z.object({ t: z.literal('user.text'), text: z.string() }),

  /** 用户语音转写结果（M4；partial 只上屏不唤醒 Agent） */
  z.object({ t: z.literal('user.speech'), text: z.string(), final: z.boolean() }),

  /**
   * 用户完成一组笔画后的聚合通知（300ms 静默后由客户端发出）。
   * 文档内容已经通过 Yjs 同步过来了，这里只是"该唤醒 Agent 看看了"的信号。
   */
  z.object({
    t: z.literal('user.draw'),
    shapeIds: z.array(z.string()),
    region: RectSchema,
  }),

  z.object({ t: z.literal('user.select'), shapeIds: z.array(z.string()) }),
  z.object({ t: z.literal('user.viewport'), rect: RectSchema, zoom: z.number() }),

  /** 接受/拒绝 AI 的提案 */
  z.object({ t: z.literal('suggest.resolve'), opId: z.string(), accept: z.boolean() }),

  /** 打断当前 agent turn */
  z.object({ t: z.literal('agent.abort') }),

  /** 回答 interact.ask_user */
  z.object({ t: z.literal('agent.answer'), askId: z.string(), answer: z.string() }),

  /** 会话设置 */
  z.object({
    t: z.literal('session.config'),
    editMode: z.enum(['suggest', 'direct']).optional(),
    voice: z.boolean().optional(),
  }),

  z.object({ t: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/* ------------------------------------------------------------------ *
 * 服务端 → 客户端
 * ------------------------------------------------------------------ */

export const ToolCallViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.unknown(),
  state: z.enum(['running', 'ok', 'error']),
  /** 给用户看的一行摘要，如「画了 1 个三角形」 */
  summary: z.string().optional(),
  diff: SceneDiffSchema.optional(),
  error: z.string().optional(),
  ms: z.number().optional(),
});
export type ToolCallView = z.infer<typeof ToolCallViewSchema>;

export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('joined'),
    roomId: z.string(),
    selfId: z.string(),
    agentId: z.string(),
    editMode: z.enum(['suggest', 'direct']),
  }),

  /** Agent turn 生命周期 */
  z.object({ t: z.literal('agent.turn.start'), turnId: z.string() }),
  z.object({ t: z.literal('agent.turn.end'), turnId: z.string(), reason: z.string() }),

  /** 流式文本 */
  z.object({ t: z.literal('agent.text'), turnId: z.string(), delta: z.string() }),

  /** 工具调用可视化 */
  z.object({ t: z.literal('agent.tool'), turnId: z.string(), call: ToolCallViewSchema }),

  /** 状态气泡：「正在看你的图…」 */
  z.object({ t: z.literal('agent.status'), text: z.string() }),

  /** 长任务进度 */
  z.object({
    t: z.literal('agent.todo'),
    items: z.array(z.object({ text: z.string(), done: z.boolean() })),
  }),

  /** AI 光标 —— 制造在场感 */
  z.object({ t: z.literal('agent.pointer'), to: PointSchema, ms: z.number() }),

  /** 视口控制（讲解时把用户视线带过去） */
  z.object({
    t: z.literal('agent.viewport'),
    rect: RectSchema.optional(),
    zoom: z.number().optional(),
    animate: z.boolean().default(true),
  }),

  /** 聚光/高亮 */
  z.object({
    t: z.literal('agent.spotlight'),
    shapeIds: z.array(z.string()),
    dim: z.number().default(0.15),
  }),
  z.object({
    t: z.literal('agent.highlight'),
    shapeIds: z.array(z.string()),
    kind: z.enum(['glow', 'outline', 'pulse']),
    ms: z.number().default(1200),
  }),

  /** 提案待确认 */
  z.object({
    t: z.literal('agent.suggest'),
    opId: z.string(),
    summary: z.string(),
    shapeIds: z.array(z.string()),
  }),

  /** 提问，等用户回答 */
  z.object({
    t: z.literal('agent.ask'),
    askId: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
  }),

  /** TTS 音频通过 0x03 帧走，这里只发文本与播放控制 */
  z.object({ t: z.literal('agent.say'), text: z.string(), interruptible: z.boolean().default(true) }),

  z.object({ t: z.literal('error'), message: z.string(), detail: z.string().optional() }),
  z.object({ t: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/* ------------------------------------------------------------------ *
 * Agent 事件队列的输入 —— 语音、绘画、文字在这里统一
 * ------------------------------------------------------------------ */

export const AgentInputEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string(), at: z.number() }),
  z.object({ kind: z.literal('speech'), text: z.string(), at: z.number() }),
  z.object({
    kind: z.literal('draw'),
    shapeIds: z.array(z.string()),
    region: RectSchema,
    at: z.number(),
  }),
  z.object({ kind: z.literal('select'), shapeIds: z.array(z.string()), at: z.number() }),
  z.object({ kind: z.literal('answer'), askId: z.string(), answer: z.string(), at: z.number() }),
]);
export type AgentInputEvent = z.infer<typeof AgentInputEventSchema>;

export const encodeControl = (msg: ServerMessage | ClientMessage): Uint8Array =>
  encodeFrame(FrameTag.Control, new TextEncoder().encode(JSON.stringify(msg)));
