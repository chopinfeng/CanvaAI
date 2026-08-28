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
   * 自上一次判定（tutor_judge）以来，有没有真的画过新东西（canvas_create /
   * canvas_ink 成功过）。
   *
   * 用户直接要求"尽量做到每次对话都能在板书上留下内容"——跟
   * markedSinceAsk 是同一类问题，同一种药方：光在提示词里说"讲一步
   * 写一步"，真机反复验证过不够稳——有的轮次写了，有的轮次判完就直接
   * 问下一题，板书原地不动。这道闸卡在"判完这一轮，问下一轮"之间：
   * 判定完成就把它拨回 false，下一次 interact_ask_user 之前必须先有
   * 一次真的落笔，才把它重新拨成 true。初始值给 true——辅导刚开始、
   * 学生还一个字没答时问第一个问题，没什么"这一步"可写，不该被拦。
   */
  drawnSinceJudge: boolean;
  /**
   * drawnSinceJudge 那道闸连着拦了 interact_ask_user 几次。
   *
   * 真机复现过一场真正的死局：判完第三问之后，drawnSinceJudge 连拦了
   * 三次提问，模型没有像别的场次那样很快补一笔，回合活活耗成了空转
   * 超时——演练脚本判定"两边都没动静"，整场作废，比"这一步没画"更糟。
   * 跟 graphicsBlockCount / drawBlockCount 是同一类问题：硬闸只挡了
   * "不画就想过关"，没给"这次是真的卡住了、想不出该画什么或者慢半拍"
   * 的情况留退路，等于把"这一步板书跟没跟上"的质量问题变成了
   * "这一轮能不能往下走"的生死问题。连着卡够次数就放行这一次，
   * 计数清零——不是从此躺平，下一轮判完照样要求先画。
   */
  drawAskBlockCount: number;
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
   * 这场辅导里，真的画出过几个**图形**（非 text/latex 的图元——
   * line/arrow/polygon/path/freedraw/ellipse/rect/image 等），
   * 而不是又写了一段文字。
   *
   * 用户点破过这轮修复的盲区："我指的板书是 canva 上画图案，而不是
   * chat"。drawCount 只统计"画过几次"，没管画的是文字还是图形——
   * 结果模型把公式、算式一条条拆成一个个 text 图元，数量凑够了门槛，
   * 但画布上还是一片文字，没有一笔真正的示意图、曲线、坐标系。
   * 这两件事必须分开算：drawCount 保证"讲一步写一步"的密度，
   * 这个字段保证密度里至少有一部分是真的图案，不能全是文字。
   */
  graphicalDrawCount: number;
  /**
   * tutor_finish 因为"一个图案都没有"被拒了几次。
   *
   * 真机复现过一次真正的卡死：加了"至少一个图案"的硬闸之后，模型在
   * 一道纯符号推导的微分方程题上，反复说"我已经把过程画在画布上了"
   * 却始终没有真的创建出一个非文字图元——大概率是不知道该画什么、
   * 或者画曲线要采样坐标点这件事本身对它太难，卡在"嘴上说画了、
   * 手上没真画"这个状态，接着开始把同一批总结话术颠来倒去地重复，
   * 十分钟没有任何新进展。硬闸挡住了"应付了事"，但没给"确实想不出
   * 该画什么"这种情况留退路，等于把"讲得好不好"的问题变成了"能不能
   * 讲完"的问题——这比没图更糟。这里记下被这道闸拦了几次，连着卡了
   * 好几次就放行，让"至少一笔图案"从硬性要求退成"尽量做到"。
   */
  graphicsBlockCount: number;
  /**
   * tutor_finish 因为"画得不够多"被拒了几次。
   *
   * 真机录像复现过：一道 4 问的微分方程，问答了 8 轮，门槛算出来要
   * 至少 6 笔。模型确实在认真回应这道闸——一次次重试 tutor_finish，
   * 画布上的笔数从 0 一路加到 1、2、3……不是敷衍，是真的在补。但补到
   * 第 3 笔就没了后劲：连着两三次只重复一句"我需要补充一些板书内容"，
   * 却不再真的调 canvas_create，最后卡到录像脚本自己的"双方都没动静"
   * 超时才收场——tutor_finish 全程一次都没通过，这场辅导严格意义上
   * 没有正常结束。跟 graphicsBlockCount 是同一类问题：硬闸只挡了
   * "应付了事"，没给"确实差一点、但补不上"这种情况留退路。这里记下
   * 被这道闸拦了几次，连着卡够次数就放行——不能让"板书够不够密"
   * 这个质量问题，变成"这场辅导能不能有个结尾"的问题。
   */
  drawBlockCount: number;
  /**
   * 这场辅导里，一字不差问过的问题。
   *
   * 拆题条数够、条目也不撞"理解题目"这类空转标签的黑名单，会话还是
   * 卡住过：真机复现过一条挂靠着具体符号的条目——"理解题目条件和图形"，
   * 措辞绕开了黑名单的枚举，但一样是个没有明确"何时算完成"标准的条目。
   * 学生把同一个问题（"直线和圆可能有哪些位置关系"）答对了两次，
   * 老师还是一字不差地把它问了第二遍。黑名单堵不完所有可能的措辞，
   * 但"一模一样的问题问了第二遍"这个症状本身是可以直接拦的——
   * 不管判定是 right 还是 wrong，问过的原话不该再一字不差地问一次
   * （真机也复现过 wrong 那一侧：学生说"不太清楚"，判了 wrong，
   * 同一句问题又被原样问了三遍，中间没有真的换角度或拆小）。
   */
  askedQuestions: string[];
  /**
   * 同一批"没打勾的小问"，账答对了却连着几轮原样不动——计数。
   *
   * 前两道闸（黑名单挡空转标签、精确匹配挡一字不差的重复提问）都是
   * 按"这句话长什么样"来拦的，真机反复复现过绕过它们的新花样：
   * 一条措辞完全具体、也没撞黑名单的条目（"求函数在约束条件下的极值点"），
   * 学生把它内含的每一个子步骤都依次答对了——列方程、解方程、验证性质、
   * 复述全过程——账本却始终不给这条打勾，老师只能一轮轮换着法子重问
   * 同一件事，措辞每次都不完全一样，精确匹配的闸也躲了过去。
   * 这两道闸看的是"问题长什么样"，这道闸看的是"账本动没动"——
   * 不管话术怎么变，undone 的集合连着两轮纹丝不动，本身就是信号。
   */
  stuckStreak: number;
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
