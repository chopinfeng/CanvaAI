import { z } from 'zod';

/**
 * K12-KGraph 的数据格式。
 *
 * 图谱本体来自 https://github.com/haolpku/K12-KGraph ——
 * 从人教版等官方教材里抽出来的 K1–K12 学科知识图谱，
 * 10685 个节点 / 23278 条边，覆盖数学、物理、化学、生物。
 * 选它的理由是**每条边都带 evidence 回指教材原文**：
 * 讲题时要说"这一步依赖前面哪个知识点"，得说得出依据，不能是模型现编的。
 *
 * 这里的 schema 照着仓库 demo/kg/*.json 的实际字段写，不是照着文档猜的。
 * 属性字段随节点类型变化很大（Concept 有 definition/formula，Exercise 有 stem/answer），
 * 所以 properties 一律宽松收下，只把我们真正要用的几个拎出来。
 */

/** 节点类型。7 种，和上游一致 */
export const KgNodeLabelSchema = z.enum([
  'Book',
  'Chapter',
  'Section',
  'Concept',
  'Skill',
  'Experiment',
  'Exercise',
]);
export type KgNodeLabel = z.infer<typeof KgNodeLabelSchema>;

/**
 * 边类型。
 *
 * 对辅导最有用的是 `prerequisites_for`（学这个之前得先会那个）——
 * 学生卡住时，顺着它往回退一步就知道该补哪儿。
 */
export const KgEdgeTypeSchema = z.enum([
  'appears_in',
  'is_a',
  'is_part_of',
  'prerequisites_for',
  'relates_to',
  'tests_concept',
  'tests_skill',
  'verifies',
  'derived_from',
]);
export type KgEdgeType = z.infer<typeof KgEdgeTypeSchema>;

export const KgNodeSchema = z.object({
  id: z.string(),
  label: KgNodeLabelSchema,
  name: z.string(),
  properties: z.record(z.unknown()).default({}),
});
export type KgNode = z.infer<typeof KgNodeSchema>;

/**
 * 上游的边有两种写法，别被文档里的单条形式骗了。
 *
 * 普通边是 source/target 一对一；而 `tests_concept` / `tests_skill`
 * ——也就是「这道题考了哪些知识点」——是**一对多**：没有 target 字段，
 * 改用 `target_name_to_ids` 装一串。实测 285 条边里有 32 条是这种，
 * 而且恰恰是把"学生做完这道题"映射到知识点的那一类，丢了整个功能就废了。
 * 所以这里两种都收，装图时再摊平成一条一条（见 graph.ts 的 load）。
 */
export const KgEdgeSchema = z.object({
  source: z.string(),
  target: z.string().optional(),
  type: KgEdgeTypeSchema,
  source_name: z.string().optional(),
  target_name: z.string().optional(),
  /** 题干原文，只有 Exercise 出发的边带 */
  source_stem: z.string().optional(),
  /** 一对多写法：一道题考的那一串知识点 */
  target_name_to_ids: z
    .array(z.object({ target: z.string(), target_name: z.string().optional() }))
    .optional(),
  properties: z.record(z.unknown()).default({}),
});
export type KgEdgeRaw = z.infer<typeof KgEdgeSchema>;

/** 摊平之后的边：到这一层 target 一定有 */
export type KgEdge = Omit<KgEdgeRaw, 'target' | 'target_name_to_ids'> & { target: string };

/**
 * 一册教材一个文件。
 *
 * 节点和边都用 `unknown` 收，逐条 safeParse——整册严格解析的话，
 * 285 条边里坏 1 条就一个节点都进不来。教材数据是外部产物，
 * 得按"大体可信但会有脏数据"来对待。
 */
export const KgFileSchema = z.object({
  nodes: z.array(z.unknown()).default([]),
  edges: z.array(z.unknown()).default([]),
});
export type KgFile = z.infer<typeof KgFileSchema>;

/* ------------------------------------------------------------------ *
 * 掌握度
 * ------------------------------------------------------------------ */

/**
 * 一个学生在一个知识点上的掌握度。
 *
 * 不用简单的对错计数，用带遗忘的滑动更新（见 mastery.ts）：
 * 上周做对过不等于今天还会，而刚刚在辅导里被引导着做对，
 * 也不等于独立掌握了。这些差别必须留在数据里，否则图谱只是个好看的装饰。
 */
export const MasterySchema = z.object({
  conceptId: z.string(),
  /** 0~1。0.6 以上算基本掌握，0.3 以下算薄弱 */
  level: z.number().min(0).max(1),
  attempts: z.number().int().min(0),
  correct: z.number().int().min(0),
  /** 最近一次练到它的时间戳 */
  lastSeen: z.number(),
  /** 最近一次是对是错，画图时用来标"刚栽过" */
  lastOk: z.boolean().optional(),
});
export type Mastery = z.infer<typeof MasterySchema>;

export const LearnerStateSchema = z.object({
  learnerId: z.string(),
  mastery: z.record(MasterySchema).default({}),
  updatedAt: z.number().default(0),
});
export type LearnerState = z.infer<typeof LearnerStateSchema>;

/** 一次练习的结果，喂给掌握度更新 */
export const AttemptSchema = z.object({
  conceptId: z.string(),
  ok: z.boolean(),
  /**
   * 这次是自己做出来的，还是被一路引导着做出来的。
   * 被引导着做对不该和独立做对记一样的分。
   */
  guided: z.boolean().default(false),
  at: z.number().default(() => Date.now()),
});
export type Attempt = z.infer<typeof AttemptSchema>;
