import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * 基础几何
 * ------------------------------------------------------------------ */

export const PointSchema = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof PointSchema>;

/** [x, y, w, h]，页面坐标系：左上原点，y 向下 */
export const RectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Rect = z.infer<typeof RectSchema>;

/** 手绘点：[x, y, 压感?] */
export const InkPointSchema = z.union([
  z.tuple([z.number(), z.number()]),
  z.tuple([z.number(), z.number(), z.number()]),
]);
export type InkPoint = z.infer<typeof InkPointSchema>;

/* ------------------------------------------------------------------ *
 * 图层
 * ------------------------------------------------------------------ */

/**
 * user   用户内容，AI 默认只读
 * ai     AI 的正式产出，可整层切换/删除
 * suggest AI 提案，半透明 ghost，用户 Accept 后 promote 到 ai
 * annot  批注/高亮/辅助线，讲解用，不属于作品本体
 */
export const LayerIdSchema = z.enum(['user', 'ai', 'suggest', 'annot']);
export type LayerId = z.infer<typeof LayerIdSchema>;

export const LAYER_ORDER: readonly LayerId[] = ['user', 'ai', 'annot', 'suggest'];

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */

export const StyleSchema = z.object({
  stroke: z.string().optional(),
  strokeWidth: z.number().optional(),
  /** 虚线段长，如 [6, 4]；空数组表示实线 */
  dash: z.array(z.number()).optional(),
  fill: z.string().optional(),
  opacity: z.number().min(0).max(1).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.string().optional(),
  /** 箭头端点样式 */
  arrowStart: z.boolean().optional(),
  arrowEnd: z.boolean().optional(),
  /** 手绘风抖动强度 0~1，0 为规整 */
  roughness: z.number().min(0).max(1).optional(),
});
export type Style = z.infer<typeof StyleSchema>;

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

export const ShapeTypeSchema = z.enum([
  'rect',
  'ellipse',
  'polygon',
  'line',
  'arrow',
  'path',
  'freedraw',
  'text',
  'latex',
  'image',
  'group',
  'plot',
  'construct',
]);
export type ShapeType = z.infer<typeof ShapeTypeSchema>;

export const AuthorSchema = z.object({
  id: z.string(),
  kind: z.enum(['user', 'ai']),
  name: z.string().optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

/**
 * 几何约束：construct 型图元靠它在父对象移动时自动重算。
 * 例：{ kind: 'midpoint', args: ['sh_b', 'sh_c'] } —— D 永远是 BC 中点。
 */
export const ConstraintSchema = z.object({
  kind: z.enum([
    'midpoint',
    'perpendicular',
    'parallel',
    'bisector',
    'circumcircle',
    'incircle',
    'tangent',
    'reflect',
    'intersection',
    'extend',
  ]),
  args: z.array(z.string()),
  params: z.record(z.number()).optional(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

/** 连接绑定：箭头两端锚在图元上，图元移动时自动重算 */
export const BindingSchema = z.object({
  shapeId: z.string(),
  anchor: z.enum(['center', 'auto', 'top', 'right', 'bottom', 'left']).default('auto'),
});
export type Binding = z.infer<typeof BindingSchema>;

export const AnimSpecSchema = z.object({
  kind: z.enum(['draw', 'fade', 'none']).default('draw'),
  ms: z.number().default(600),
  delay: z.number().default(0),
});
export type AnimSpec = z.infer<typeof AnimSpecSchema>;

export const ShapeSchema = z.object({
  id: z.string(),
  type: ShapeTypeSchema,
  layer: LayerIdSchema,
  author: AuthorSchema,
  /** 同一次动作共享 —— 一次撤销的粒度 */
  opId: z.string(),

  x: z.number(),
  y: z.number(),
  rotation: z.number().default(0),
  /** 分数索引，插入不重排 */
  z: z.number(),

  /** rect / ellipse / image / text 的尺寸 */
  w: z.number().optional(),
  h: z.number().optional(),

  /** line / arrow / polygon / path / freedraw 的点序列，相对 (x, y) */
  points: z.array(InkPointSchema).optional(),
  /** polygon / path 是否闭合 */
  closed: z.boolean().optional(),

  /** text / latex 内容 */
  text: z.string().optional(),
  /** image 资源 */
  assetId: z.string().optional(),
  /** group 成员 */
  children: z.array(z.string()).optional(),
  /** plot 的参数化定义，可重算 */
  plot: z
    .object({ expr: z.string(), varName: z.string().default('x'), from: z.number(), to: z.number() })
    .optional(),
  /** construct 的约束 */
  constraint: ConstraintSchema.optional(),
  /** arrow 的两端绑定 */
  bindStart: BindingSchema.optional(),
  bindEnd: BindingSchema.optional(),

  style: StyleSchema.default({}),

  /**
   * 语义层 —— 这是 Agent 的记忆锚点。
   * { role: 'roof', refs: ['sh_house'], note: '用户要求的三角屋顶' }
   */
  meta: z
    .object({
      role: z.string().optional(),
      refs: z.array(z.string()).optional(),
      label: z.string().optional(),
      note: z.string().optional(),
    })
    .catchall(z.unknown())
    .default({}),

  /** 客户端渲染提示，不影响文档终态 */
  anim: AnimSpecSchema.optional(),

  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Shape = z.infer<typeof ShapeSchema>;

/** 工具/客户端创建 shape 时的输入：省略所有由系统填充的字段 */
/**
 * 创建图元的输入。
 *
 * 坐标约定（这里只有一种写法，没有歧义）：
 * - 有 points 的图元（line/arrow/polygon/path/freedraw）：**points 直接写画布绝对坐标**，
 *   x/y 不用填，系统会从 points 推导出原点并转成内部的相对表示。
 * - 没有 points 的图元（rect/ellipse/text/image）：用 x/y + w/h 定位。
 *
 * 早先要求 points 相对于 (x,y)，模型会习惯性地既给绝对 points 又给 x/y，
 * 结果偏移叠加两次，图形飞到画布外——所以改成单一约定。
 */
export const ShapeInputSchema = ShapeSchema.omit({
  id: true,
  author: true,
  opId: true,
  z: true,
  createdAt: true,
  updatedAt: true,
  layer: true,
})
  .partial({ rotation: true, style: true, meta: true, x: true, y: true })
  .extend({
    id: z.string().optional(),
    layer: LayerIdSchema.optional(),
  });
export type ShapeInput = z.infer<typeof ShapeInputSchema>;

/** query 返回的摘要，约 15 token —— 渐进披露的第一级 */
export const ShapeBriefSchema = z.object({
  id: z.string(),
  type: ShapeTypeSchema,
  layer: LayerIdSchema,
  bbox: RectSchema,
  role: z.string().optional(),
  label: z.string().optional(),
  text: z.string().optional(),
});
export type ShapeBrief = z.infer<typeof ShapeBriefSchema>;

/* ------------------------------------------------------------------ *
 * 空间关系
 * ------------------------------------------------------------------ */

export const RelationKindSchema = z.enum([
  'contains',
  'inside',
  'touches',
  'intersects',
  'above',
  'below',
  'left-of',
  'right-of',
  'parallel',
  'perpendicular',
  'aligned-x',
  'aligned-y',
]);
export type RelationKind = z.infer<typeof RelationKindSchema>;

export const RelationSchema = z.object({
  a: z.string(),
  b: z.string(),
  kind: RelationKindSchema,
  /** 距离/夹角等数值，随 kind 而定 */
  value: z.number().optional(),
});
export type Relation = z.infer<typeof RelationSchema>;

/* ------------------------------------------------------------------ *
 * 场景 diff —— 写工具的返回，让 Agent 自检
 * ------------------------------------------------------------------ */

export const SceneDiffSchema = z.object({
  opId: z.string(),
  created: z.array(z.string()).default([]),
  updated: z.array(z.string()).default([]),
  deleted: z.array(z.string()).default([]),
});
export type SceneDiff = z.infer<typeof SceneDiffSchema>;
