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
  /**
   * 这次辅导挂上的知识点，以及每一次判定落在它们身上的结果。
   * 讲完时一次性写进掌握度——中途写的话，学生半路走人会留下一堆
   * "被引导着做对了"的假记录。
   */
  attempts: Array<{ conceptId: string; ok: boolean; guided: boolean }>;
  /**
   * 这道题落在图谱上的哪些知识点。
   *
   * 拆题时就由服务端反查好，不等模型自觉去调 kg_lookup——实测
   * stealth/ox-alpha 整场辅导一次都没查，于是七次判定一个知识点都没记上，
   * "学生学到了什么"这条产品主线在那一整场里等于不存在，而且不报错。
   * 交给模型的自觉性的东西，迟早有一天它不做。
   */
  concepts: string[];
  /**
   * 他答了但还没给判定的那一次。
   * 有值的时候不许再提下一个问题——否则他一路答下来，
   * 不知道自己刚才那步是对是错，等于白答。
   */
  pending: { question: string; answer: string } | null;
  /**
   * 上次打勾之后，用户又答对了几次。
   *
   * 打勾的门票。没有它，模型会在用户一个字都没答的时候连调两次 tutor_plan
   * 把小问标成 done——实测就是这么绕过开局那道限制的。
   */
  rightSince: number;
  /**
   * 自上一个问题以来，有没有在图上指过东西（高亮/聚光/带看/画辅助线）。
   *
   * "△ECF 里直角在哪个顶点" 这种问题，配着图上点亮的那块看，
   * 和光读一行字，是两件事。没标就问，等于让他在文字里猜你指哪儿。
   */
  markedSinceAsk: boolean;
  /**
   * 这场辅导里，真的画过几笔新东西（canvas_create / canvas_ink 成功的次数），
   * 不算把画布上已经有的字/图高亮一下。
   *
   * 真机反馈过两轮：第一轮全程零画，"基本都是 chat"，加了"至少画一笔"
   * 的门槛；结果第二轮卡着门槛底线交差——一整场三问的辅导，从头到尾
   * 只有一次 canvas_create，跟老师上课的板书完全不是一回事：板书是
   * 讲一步、写一步，公式、算式、图形随着讲解一点点铺满黑板，不是
   * 讲完全程再象征性地补一笔。所以这不只是"有没有画"，还得看"画得
   * 够不够"——数量本身就是及格线的一部分。
   */
  drawCount: number;
  /**
   * 这场辅导里，一字不差问过的问题。
   *
   * 拆题条数够、条目也不撞"理解题目"这类空转标签的黑名单，会话还是
   * 卡住过：真机复现过一条挂靠着具体符号的条目——"理解题目条件和图形"，
   * 措辞绕开了黑名单的枚举，但一样是个没有明确"何时算完成"标准的条目。
   * 学生把同一个问题（"直线和圆可能有哪些位置关系"）答对了两次，
   * 老师还是一字不差地把它问了第二遍。黑名单堵不完所有可能的措辞，
   * 但"一模一样的问题问了第二遍"这个症状本身是可以直接拦的——
   * 不管是哪种说法绕出来的，问过又判过对的问题不该再问一次。
   */
  askedQuestions: string[];
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
  /**
   * 用户在这一轮里主动喊过停（"直接给答案""先不学了"）。
   *
   * tutor_plan 会在没进辅导模式时**自动进入**——模型决定开始拆题，
   * 这件事本身就是最强的意图信号。但用户刚说完不想学，
   * 就不能让模型一调 tutor_plan 又把他拖回去。这个标记就是为了区分这两种。
   */
  tutorJustExited?: boolean;
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

/**
 * 知识图谱的出口。
 *
 * agent 包不认识服务端的图和存储，只认这个口子——
 * 单测里塞个假的就能验证"讲完一道题之后掌握度确实变了"，
 * 不用起一个真的图谱服务。
 */
export interface KnowledgePort {
  /** 按名字找知识点，讲题前用它把"勾股定理"落到一个真实的 id 上 */
  search(query: string, limit?: number): Array<{ id: string; name: string; label: string; definition?: string }>;
  /**
   * 哪些知识点的名字出现在这段话里。
   *
   * 和 search 方向相反：search 适合"用户输入一个词"，mentions 适合
   * "手里有一整句话"。辅导拆出来的小问是整句话，拿它去 search 一定查不到。
   */
  mentions(text: string, limit?: number): Array<{ id: string; name: string; label: string }>;
  /** 学这个之前得先会哪些——学生卡住时顺着它往回退一步 */
  prerequisites(id: string): Array<{ id: string; name: string }>;
  /** 记一批练习结果，落到这个学生的掌握度上 */
  record(attempts: Array<{ conceptId: string; ok: boolean; guided: boolean }>): Promise<void>;
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
  knowledge?: KnowledgePort;

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
