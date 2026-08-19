import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AnimSpecSchema,
  LayerIdSchema,
  PointSchema,
  RectSchema,
  RelationSchema,
  SceneDiffSchema,
  ShapeBriefSchema,
  ShapeInputSchema,
  ShapeSchema,
  ShapeTypeSchema,
  StyleSchema,
} from './shape.js';

/* ------------------------------------------------------------------ *
 * 统一返回信封
 *
 * 失败必须带 hint —— 告诉 Agent 下一步怎么办，而不是只说哪里错了。
 * 这是"错误可恢复"的机制保证，不是文档约定。
 * ------------------------------------------------------------------ */

export type ToolOk<T> = { ok: true; data: T; diff?: z.infer<typeof SceneDiffSchema> };
export type ToolErr = { ok: false; error: string; hint: string };
export type ToolResult<T = unknown> = ToolOk<T> | ToolErr;

export const ok = <T>(data: T, diff?: z.infer<typeof SceneDiffSchema>): ToolOk<T> =>
  diff ? { ok: true, data, diff } : { ok: true, data };

export const err = (error: string, hint: string): ToolErr => ({ ok: false, error, hint });

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */

export interface ToolDef<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  /** 给模型看的描述。写清楚"什么时候用"，比"是什么"更重要。 */
  description: string;
  input: I;
  /** 只读工具不产生 op，可并行执行 */
  readonly: boolean;
}

export function defineTool<I extends z.ZodTypeAny>(def: {
  name: string;
  description: string;
  input: I;
  readonly?: boolean;
}): ToolDef<I> {
  return { readonly: false, ...def };
}

/** 转成 OpenAI / DeepSeek function-calling 格式 */
export function toFunctionSchema(def: ToolDef): {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
} {
  const parameters = zodToJsonSchema(def.input, {
    target: 'openApi3',
    $refStrategy: 'none',
  });
  return {
    type: 'function',
    function: { name: def.name, description: def.description, parameters },
  };
}

/* ------------------------------------------------------------------ *
 * 引用：可以指一个图元、一个点、或图元上的锚点
 * ------------------------------------------------------------------ */

export const RefSchema = z.union([
  z.string().describe('图元 id'),
  PointSchema.describe('绝对坐标点'),
  z.object({
    id: z.string(),
    anchor: z.enum(['center', 'start', 'end', 'top', 'right', 'bottom', 'left']),
  }),
]);
export type Ref = z.infer<typeof RefSchema>;

/* ================================================================== *
 * canvas.read
 * ================================================================== */

export const canvasQuery = defineTool({
  name: 'canvas_query',
  description:
    '扫描画布，返回图元摘要列表（id/类型/包围盒/语义角色）。这是了解画布内容的第一步——先用它看有什么，' +
    '再用 canvas_describe 下钻细节。不要一次拉全部，用 region/type/role 缩小范围。',
  readonly: true,
  input: z.object({
    type: z.array(ShapeTypeSchema).optional().describe('按图元类型过滤'),
    layer: z.array(LayerIdSchema).optional().describe('按图层过滤'),
    role: z.array(z.string()).optional().describe('按语义角色过滤，如 ["roof","wall"]'),
    region: RectSchema.optional().describe('只要与该矩形 [x,y,w,h] 相交的图元'),
    near: z
      .object({ id: z.string(), within: z.number() })
      .optional()
      .describe('某图元附近 within px 内的图元'),
    text: z.string().optional().describe('文本内容包含该子串'),
    limit: z.number().int().min(1).max(200).default(30),
  }),
});

export const canvasDescribe = defineTool({
  name: 'canvas_describe',
  description:
    '获取指定图元的完整几何与样式，可选附带图元之间的空间关系（包含/相邻/平行/垂直/对齐）。' +
    '在需要精确坐标、或需要判断图形之间怎么摆放时用。',
  readonly: true,
  input: z.object({
    ids: z.array(z.string()).optional(),
    region: RectSchema.optional(),
    detail: z.enum(['brief', 'full']).default('full'),
    relations: z.boolean().default(false).describe('是否计算图元间空间关系'),
  }),
});

export const canvasMeasure = defineTool({
  name: 'canvas_measure',
  description:
    '精确测量：距离、夹角、面积、长度、交点、包围盒。' +
    '任何涉及数值的判断都用它，不要自己心算坐标。',
  readonly: true,
  input: z.object({
    a: RefSchema,
    b: RefSchema.optional(),
    what: z.enum(['distance', 'angle', 'area', 'length', 'intersection', 'bbox']),
  }),
});

export const canvasHitTest = defineTool({
  name: 'canvas_hit_test',
  description: '查询某个点上（或附近 radius 内）有哪些图元。用于「用户指的是哪个东西」这类判断。',
  readonly: true,
  input: z.object({ point: PointSchema, radius: z.number().default(8) }),
});

export const canvasSnapshot = defineTool({
  name: 'canvas_snapshot',
  description:
    '把画布某个区域渲染成图片。设 describe=true 时会调用视觉模型给出文字描述。' +
    '仅在结构化查询不够用时使用——比如需要理解用户的手绘笔触画的是什么，或读位图里的内容。' +
    '普通的图形关系判断请用 canvas_query / canvas_describe，更准也更省。',
  readonly: true,
  input: z.object({
    region: RectSchema.optional().describe('省略则取所有内容的包围盒'),
    scale: z.number().min(0.1).max(3).default(1),
    describe: z.boolean().default(true),
    question: z.string().optional().describe('想让视觉模型重点回答的问题'),
  }),
});

export const canvasGetSelection = defineTool({
  name: 'canvas_get_selection',
  description: '用户当前选中了哪些图元。用户说「这个」「它」的时候先查这个。',
  readonly: true,
  input: z.object({}),
});

export const canvasGetViewport = defineTool({
  name: 'canvas_get_viewport',
  description: '用户当前看到的画布区域和缩放级别。决定在哪里落笔时参考它，别画到屏幕外。',
  readonly: true,
  input: z.object({}),
});

/* ================================================================== *
 * canvas.write
 * ================================================================== */

export const canvasCreate = defineTool({
  name: 'canvas_create',
  description:
    '创建图元。一次调用可创建多个，它们共享一个 opId，用户撤销时会一起撤销——所以属于同一个动作的图形请放在一次调用里。' +
    '默认落在 ai 图层。给 meta.role 和 meta.refs 赋值很重要：那是你下一轮认出自己画过什么的依据。\n' +
    '坐标写法只有一种，不要混：\n' +
    '· line/arrow/polygon/path/freedraw —— points 直接写画布绝对坐标，**不要填 x/y**。\n' +
    '  例：三角形屋顶压在 bbox 为 [320,384,208,160] 的墙上，写 points: [[320,384],[424,300],[528,384]]。\n' +
    '· rect/ellipse/text/image —— 用 x/y 定左上角，配 w/h（text 用 text 字段）。',
  input: z.object({
    shapes: z.array(ShapeInputSchema).min(1),
    layer: LayerIdSchema.optional().describe('默认 ai；讲解用的辅助线用 annot'),
    anim: AnimSpecSchema.optional().describe('落笔动画，默认逐段描出'),
  }),
});

export const canvasUpdate = defineTool({
  name: 'canvas_update',
  description: '修改已有图元的属性。修改 user 图层的图元会被拒绝，除非会话处于 direct 模式。',
  input: z.object({
    patches: z
      .array(z.object({ id: z.string(), set: ShapeSchema.partial() }))
      .min(1),
    force: z.boolean().default(false).describe('尝试修改 user 图层内容时需要显式置 true'),
  }),
});

export const canvasDelete = defineTool({
  name: 'canvas_delete',
  description: '删除图元。同样不能删 user 图层的内容（除非 direct 模式 + force）。',
  input: z.object({ ids: z.array(z.string()).min(1), force: z.boolean().default(false) }),
});

export const canvasTransform = defineTool({
  name: 'canvas_transform',
  description: '平移/缩放/旋转一批图元，围绕共同的 origin。',
  input: z.object({
    ids: z.array(z.string()).min(1),
    translate: PointSchema.optional(),
    scale: z.union([z.number(), PointSchema]).optional(),
    rotate: z.number().optional().describe('角度，顺时针为正'),
    origin: z.union([PointSchema, z.enum(['center', 'topleft'])]).default('center'),
  }),
});

export const canvasStyle = defineTool({
  name: 'canvas_style',
  description: '批量改样式（颜色/线宽/虚线/透明度/字号）。',
  input: z.object({ ids: z.array(z.string()).min(1), style: StyleSchema }),
});

export const canvasGroup = defineTool({
  name: 'canvas_group',
  description: '把多个图元编成一组，之后可以整体移动。',
  input: z.object({ ids: z.array(z.string()).min(2), name: z.string().optional() }),
});

export const canvasAlign = defineTool({
  name: 'canvas_align',
  description: '把一批图元按某条边或中线对齐。整理草图时用。',
  input: z.object({
    ids: z.array(z.string()).min(2),
    axis: z.enum(['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom']),
  }),
});

export const canvasDistribute = defineTool({
  name: 'canvas_distribute',
  description: '把一批图元在某个方向上等距分布。',
  input: z.object({
    ids: z.array(z.string()).min(3),
    axis: z.enum(['x', 'y']),
    gap: z.number().optional().describe('省略则在现有跨度内均分'),
  }),
});

export const canvasConnect = defineTool({
  name: 'canvas_connect',
  description:
    '在两个图元之间连一条带绑定的线/箭头。绑定意味着任一端移动时连线自动重算——' +
    '画流程图、架构图时必须用它，不要自己算两点坐标画 line。',
  input: z.object({
    from: RefSchema,
    to: RefSchema,
    kind: z.enum(['arrow', 'line']).default('arrow'),
    label: z.string().optional(),
    routing: z.enum(['straight', 'ortho', 'curve']).default('straight'),
    style: StyleSchema.optional(),
  }),
});

export const canvasInk = defineTool({
  name: 'canvas_ink',
  description:
    '以手绘笔触落笔。当用户在手绘、你想让自己的产出和用户笔迹风格一致时用它，' +
    '而不是画规整的矢量图形。points 是 [x,y] 或 [x,y,压感] 的序列。',
  input: z.object({
    points: z.array(z.union([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number(), z.number()])])).min(2),
    smooth: z.boolean().default(true),
    style: StyleSchema.optional(),
    layer: LayerIdSchema.optional(),
    meta: z.record(z.unknown()).optional(),
  }),
});

export const canvasErase = defineTool({
  name: 'canvas_erase',
  description: '擦除某个矩形区域内的内容（仅限你有权限的图层）。',
  input: z.object({ region: RectSchema, layer: LayerIdSchema.optional() }),
});

/* ================================================================== *
 * canvas.view —— 讲解的主角
 * ================================================================== */

export const canvasZoomTo = defineTool({
  name: 'canvas_zoom_to',
  description: '把用户的视口移动到指定图元或区域。讲解时先带用户看向要说的地方。',
  input: z.object({
    ids: z.array(z.string()).optional(),
    region: RectSchema.optional(),
    padding: z.number().default(60),
  }),
});

export const canvasSpotlight = defineTool({
  name: 'canvas_spotlight',
  description:
    '聚焦：把这几个图元持续标出来，一直亮到你下次换地方或传空数组清掉。\n' +
    '**它不会把别处压暗**——讲题时学生要同时看清标出的那条边和它周围的图，' +
    '压暗周围等于把整张图变模糊。标出来的部分会做呼吸动画，动的东西人眼自己会追过去。\n' +
    '和 canvas_highlight(ms:0) 的区别只在幅度：这个更急一点，用于"就看这儿"。',
  input: z.object({ ids: z.array(z.string()) }),
});

export const canvasHighlight = defineTool({
  name: 'canvas_highlight',
  description:
    '高亮一批图元（发光/描边/脉冲）。用于「注意这条边」这种指示。\n' +
    '**ms=0 表示一直亮着，直到你下次高亮别的或传空数组清除。**\n' +
    '辅导时提问前的标注一定要用 ms=0——学生读题、思考、作答要几十秒，' +
    '默认的 1.2 秒早就灭了，等于没标。',
  input: z.object({
    ids: z.array(z.string()),
    kind: z.enum(['glow', 'outline', 'pulse']).default('glow'),
    /** 0 = 持续显示，直到下次高亮或清除 */
    ms: z.number().default(1200),
  }),
});

export const canvasPointerMove = defineTool({
  name: 'canvas_pointer_move',
  description:
    '移动你自己的光标。在落笔前先把光标移过去，用户会感觉到你"在场"而不是凭空生成内容。' +
    '这个细节对协作体验的影响比它看起来大。',
  input: z.object({ to: z.union([PointSchema, z.string()]), ms: z.number().default(400) }),
});

/* ================================================================== *
 * canvas.layer
 * ================================================================== */

export const canvasLayerSetVisible = defineTool({
  name: 'canvas_layer_set_visible',
  description: '显示/隐藏整个图层。',
  input: z.object({ id: LayerIdSchema, visible: z.boolean() }),
});

export const canvasLayerClear = defineTool({
  name: 'canvas_layer_clear',
  description: '清空一个图层（不能清 user 层）。收拾自己画的辅助线时用 annot。',
  input: z.object({ id: LayerIdSchema }),
});

/* ================================================================== *
 * interact
 * ================================================================== */

export const interactSay = defineTool({
  name: 'interact_say',
  description:
    '对用户说话（会走 TTS 播出来）。说重点，不要复述你刚做过的操作——用户看得见画布。' +
    '一边画一边说的节奏比画完再总结好。',
  input: z.object({
    text: z.string(),
    tone: z.enum(['neutral', 'encouraging', 'excited']).default('neutral'),
    interruptible: z.boolean().default(true),
  }),
});

export const interactAskUser = defineTool({
  name: 'interact_ask_user',
  description:
    '向用户提问并等待回答。会阻塞当前回合。只在真的会导致做错事时才问——' +
    '能自己合理假设的就直接做，做完告诉用户你的假设。',
  input: z.object({ question: z.string(), options: z.array(z.string()).optional() }),
});

export const interactSuggest = defineTool({
  name: 'interact_suggest',
  description:
    '把你画在 suggest 图层上的内容提交给用户确认。用户接受后会自动 promote 到 ai 图层。' +
    'summary 要具体：「在房子上加了一个三角形屋顶」而不是「做了一些修改」。',
  input: z.object({ opId: z.string(), summary: z.string() }),
});

export const interactSetStatus = defineTool({
  name: 'interact_set_status',
  description: '更新状态气泡，如「正在看你的图…」。长时间思考前设一下，用户就不会以为卡住了。',
  input: z.object({ text: z.string() }),
});

export const interactSetTodo = defineTool({
  name: 'interact_set_todo',
  description: '多步任务的进度清单。步骤超过 3 步时用它让用户看到你的计划。',
  input: z.object({
    items: z.array(z.object({ text: z.string(), done: z.boolean() })).min(1),
  }),
});

/* ================================================================== *
 * tutor —— 辅导模式的进度账本
 *
 * 没有这两个工具的时候，"这次辅导讲完了没有"没人记得：模型讲完第 (1) 问、
 * 用户说一句"懂了"，它就顺势收尾了，第 (2) 问再也没人提起。
 * 把待解决的小问显式记在会话上，每一轮都摆到模型眼前，它才赖不掉。
 * ================================================================== */

export const tutorPlan = defineTool({
  name: 'tutor_plan',
  description:
    '把用户问的这道题拆成他要逐个攻克的小问，或更新哪些已经攻克了。' +
    '进入辅导后的**第一件事**就是调它——没拆题就等于没人记得这次辅导要讲到哪里为止。' +
    '题目有第 (1)(2) 问就至少拆成两条；一问里要分几步想清楚的，也拆开。' +
    '每次传**完整清单**（不是增量），用户自己答出来的那条把 done 设成 true。' +
    '注意：done 的标准是"用户自己算出来了"，不是"你讲过了"。',
  input: z.object({
    items: z
      .array(z.object({ text: z.string(), done: z.boolean().default(false) }))
      .min(1),
  }),
});

export const kgLookup = defineTool({
  name: 'kg_lookup',
  description:
    '在 K12 学科知识图谱里查知识点，拿到它的 id、定义和前置知识。\n' +
    '拆完题就查一次：把「勾股定理」这几个字落到一个真实的知识点 id 上，' +
    '之后 tutor_judge 才能把他这次答得对不对记到这个点上，图谱才会跟着长。\n' +
    '学生卡住时也用它——返回的 prerequisites 就是"他可能是前面那块没学好"。',
  input: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).default(5) }),
  readonly: true,
});

export const tutorJudge = defineTool({
  name: 'tutor_judge',
  description:
    '对用户刚才的回答给个明确判定。**问完一个问题、他答了，下一步必须是这个**——' +
    '不判定就接着问下一题，他不知道自己刚才那步是对是错，一路答下来心里全是空的。' +
    'verdict：right 完全对 / partly 方向对但有错处 / wrong 不对。' +
    'comment 一句话说清「对/不对在哪」，不要在这里把下一步的答案捎带说出来。' +
    '开头不用再写"对/不对"——界面已经有判定标签了，直接说理由。' +
    'wrong 时也不准直接给正确答案，只点出矛盾在哪（"直角对着的边应该最长，你再看看"）。',
  input: z.object({
    verdict: z.enum(['right', 'partly', 'wrong']),
    comment: z.string(),
    /**
     * 这一问考的是哪几个知识点（kg_lookup 拿到的 id）。
     * 填了，这次判定就会落进他的掌握度；不填也能用，只是图谱不会长。
     */
    conceptIds: z.array(z.string()).optional(),
  }),
});

export const tutorFinish = defineTool({
  name: 'tutor_finish',
  description:
    '结束本次辅导，切回普通模式。**只有 tutor_plan 里的小问全部 done 了才会成功**，' +
    '还有没解决的会被拒绝并告诉你剩哪些。' +
    'summary 用一两句回顾他自己走通的思路（不是复述答案），说给用户听。',
  input: z.object({ summary: z.string() }),
});

/* ================================================================== *
 * 返回值 schema（供服务端自检 / 测试断言）
 * ================================================================== */

export const QueryResultSchema = z.object({
  shapes: z.array(ShapeBriefSchema),
  total: z.number(),
  truncated: z.boolean(),
});

export const DescribeResultSchema = z.object({
  shapes: z.array(ShapeSchema),
  relations: z.array(RelationSchema).optional(),
});

/* ================================================================== *
 * 注册表
 * ================================================================== */

export const TOOL_DEFS = [
  canvasQuery,
  canvasDescribe,
  canvasMeasure,
  canvasHitTest,
  canvasSnapshot,
  canvasGetSelection,
  canvasGetViewport,
  canvasCreate,
  canvasUpdate,
  canvasDelete,
  canvasTransform,
  canvasStyle,
  canvasGroup,
  canvasAlign,
  canvasDistribute,
  canvasConnect,
  canvasInk,
  canvasErase,
  canvasZoomTo,
  canvasSpotlight,
  canvasHighlight,
  canvasPointerMove,
  canvasLayerSetVisible,
  canvasLayerClear,
  interactSay,
  interactAskUser,
  interactSuggest,
  interactSetStatus,
  interactSetTodo,
  kgLookup,
  tutorPlan,
  tutorJudge,
  tutorFinish,
] as const satisfies readonly ToolDef[];

export type ToolName = (typeof TOOL_DEFS)[number]['name'];

export const TOOL_BY_NAME = new Map<string, ToolDef>(TOOL_DEFS.map((d) => [d.name, d as ToolDef]));
