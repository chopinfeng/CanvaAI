import type { Scene } from '@canvai/canvas-core';
import type { Author, LayerId, Rect, ServerMessage, ToolResult } from '@canvai/protocol';

/**
 * 一次辅导的账本。
 *
 * 关键是 outline：辅导什么时候算讲完，不能由模型当场感觉，
 * 得有一份两边都看得见的待办。用户问的是「这道题」，那 (1)(2) 两问
 * 全被他自己解出来才算完——中途他说一句"懂了"不作数。
 */
export interface TutorSession {
  /** 用户当时的原话，用来在每轮提醒模型这次到底在教什么 */
  goal: string;
  /** 待攻克的小问。全 done 才允许 tutor_finish */
  outline: Array<{ text: string; done: boolean }>;
  /** 进入辅导时的轮次，用于判断"刚进来还没拆题" */
  startedTurn: number;
}

export interface SessionState {
  /** 用户当前选中的图元——用户说「这个」时的解析依据 */
  selection: string[];
  viewport: Rect;
  zoom: number;
  /**
   * suggest：AI 改用户内容需先提案
   * direct ：AI 可直接改（用户显式开启）
   */
  editMode: 'suggest' | 'direct';
  /**
   * assist：协作画图，正常回答
   * tutor ：辅导解题，一步步引导，不给答案（见 TUTOR_ADDENDUM）
   */
  mode: 'assist' | 'tutor';
  /** 辅导进行中的账本；不在辅导里就是 null */
  tutor: TutorSession | null;
}

/** 视觉模型兜底：只在结构化查询不够用时才走 */
export interface VisionProvider {
  describe(png: Uint8Array, question?: string): Promise<string>;
}

/** SVG → PNG 光栅化。服务端注入 resvg，测试里可以注入假的。 */
export interface Rasterizer {
  render(svg: string, scale: number): Promise<Uint8Array>;
}

export interface AssetStore {
  put(bytes: Uint8Array, mime: string): Promise<string>;
  /**
   * 把 assetId 变成可内嵌的 data URI，供截图时把位图真正画进 SVG。
   * 不实现的话，图片在截图里只是个占位框——视觉模型看到的是空盒子，
   * 等于白截。
   */
  toDataUri?(assetId: string): string | undefined;
}

export interface ToolContext {
  scene: Scene;
  author: Author;
  session: SessionState;
  signal: AbortSignal;

  /** 推送给客户端的事件（光标、聚光、状态气泡…） */
  emit(msg: ServerMessage): void;

  /** 提问并等待用户回答，会阻塞当前回合 */
  ask(question: string, options?: string[]): Promise<string>;

  vision?: VisionProvider;
  rasterizer?: Rasterizer;
  assets?: AssetStore;

  /** 本回合内 AI 产生的 opId，供 interact_suggest 引用 */
  recentOpIds: string[];
}

export type ToolExecutor = (args: unknown, ctx: ToolContext) => Promise<ToolResult>;

/**
 * 图层写权限。
 *
 * 这是"AI 不会毁掉用户作品"的机制保证：user 图层默认只读，
 * 拒绝时不是简单报错，而是告诉 Agent 改走提案流程——错误可恢复。
 */
export function checkWritable(
  layer: LayerId,
  ctx: ToolContext,
  force: boolean,
): { allowed: true } | { allowed: false; error: string; hint: string } {
  if (layer !== 'user') return { allowed: true };
  if (ctx.session.editMode === 'direct' && force) return { allowed: true };
  return {
    allowed: false,
    error: `不能直接修改 user 图层的内容（当前模式：${ctx.session.editMode}）`,
    hint:
      '请改为在 suggest 图层创建你想要的效果，然后调用 interact_suggest 提交给用户确认；' +
      '若用户明确要求你直接改他的内容，先用 interact_ask_user 征得同意。',
  };
}
