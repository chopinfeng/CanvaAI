import { newOpId, rectCenter, round, shapeBounds, unionBounds } from '@canvai/canvas-core';
import type { LayerId, Point, Rect, SceneDiff, Shape, ShapeInput } from '@canvai/protocol';
import {
  canvasAlign,
  canvasConnect,
  canvasCreate,
  canvasDelete,
  canvasDistribute,
  canvasErase,
  canvasGroup,
  canvasInk,
  canvasLayerClear,
  canvasLayerSetVisible,
  canvasStyle,
  canvasTransform,
  canvasUpdate,
  err,
  ok,
} from '@canvai/protocol';
import type { ToolContext, ToolExecutor } from './context.js';
import { checkWritable } from './context.js';

/** AI 未指定图层时的默认落点：suggest 模式下也直接落 ai 层，
 *  因为 ai 层本来就是 AI 自己的地盘，用户可整层撤销。
 *  只有触碰 user 层才需要提案。 */
const defaultLayer = (ctx: ToolContext, explicit?: LayerId): LayerId =>
  explicit ?? (ctx.author.kind === 'ai' ? 'ai' : 'user');

function track(ctx: ToolContext, diff: SceneDiff): SceneDiff {
  if (!ctx.recentOpIds.includes(diff.opId)) ctx.recentOpIds.push(diff.opId);
  return diff;
}

/* ------------------------------------------------------------------ *
 * create
 * ------------------------------------------------------------------ */

export const execCreate: ToolExecutor = async (raw, ctx) => {
  const a = canvasCreate.input.parse(raw);
  const layer = defaultLayer(ctx, a.layer);

  const guard = checkWritable(layer, ctx, false);
  if (!guard.allowed) return err(guard.error, guard.hint);

  const bad = a.shapes.find((s) => !isDrawable(s));
  if (bad) {
    return err(
      `图元 type=${bad.type} 缺少必要的几何信息`,
      'rect/ellipse/image 需要 x/y/w/h；line/arrow/polygon/path/freedraw 需要至少 2 个 points（写绝对坐标，不用给 x/y）；text 需要 x/y 和 text 字段。',
    );
  }

  const { ids, diff } = ctx.scene.create(a.shapes.map(absolutePointsToLocal), {
    author: ctx.author,
    layer,
    ...(a.anim ? {} : {}),
  });

  // 落笔动画：客户端据此把路径描出来，而不是瞬间出现
  if (a.anim) ctx.scene.update(ids.map((id) => ({ id, set: { anim: a.anim } })), { origin: 'ai' });

  return ok(
    {
      ids,
      layer,
      summary: summarize(ids.map((id) => ctx.scene.get(id)!)),
    },
    track(ctx, diff),
  );
};

/**
 * points 一律按画布绝对坐标接收，这里换算成内部的「原点 + 相对点」表示。
 *
 * 内部之所以存相对坐标，是因为拖动图元时只改 x/y 就够了，不用重写整个点序列。
 * 但让模型去维护这个不变式代价太大——它会既给绝对 points 又给 x/y，
 * 于是偏移叠加两次。约定收窄到"只写绝对坐标"，换算交给这里。
 */
function absolutePointsToLocal(s: ShapeInput): ShapeInput {
  if (!s.points || s.points.length === 0) return { ...s, x: s.x ?? 0, y: s.y ?? 0 };

  const first = s.points[0]!;
  const ox = first[0] ?? 0;
  const oy = first[1] ?? 0;

  return {
    ...s,
    x: round(ox, 2),
    y: round(oy, 2),
    points: s.points.map((p) => {
      const rel: [number, number] = [round((p[0] ?? 0) - ox, 2), round((p[1] ?? 0) - oy, 2)];
      return p.length > 2 ? ([...rel, p[2]] as [number, number, number]) : rel;
    }),
  };
}

function isDrawable(s: {
  type: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  points?: unknown[];
  text?: string;
}): boolean {
  const placed = typeof s.x === 'number' && typeof s.y === 'number';
  switch (s.type) {
    case 'rect':
    case 'ellipse':
    case 'image':
      return placed && typeof s.w === 'number' && typeof s.h === 'number' && s.w > 0 && s.h > 0;
    case 'line':
    case 'arrow':
    case 'polygon':
    case 'path':
    case 'freedraw':
      return Array.isArray(s.points) && s.points.length >= 2;
    case 'text':
    case 'latex':
      return placed && typeof s.text === 'string' && s.text.length > 0;
    default:
      return true;
  }
}

function summarize(shapes: Shape[]): string {
  const byType = new Map<string, number>();
  for (const s of shapes) byType.set(s.type, (byType.get(s.type) ?? 0) + 1);
  const label = shapes.find((s) => s.meta.role)?.meta.role;
  const parts = [...byType.entries()].map(([t, n]) => `${n} 个 ${CN_TYPE[t] ?? t}`);
  return label ? `${parts.join('、')}（${label}）` : parts.join('、');
}

const CN_TYPE: Record<string, string> = {
  rect: '矩形',
  ellipse: '椭圆',
  polygon: '多边形',
  line: '线段',
  arrow: '箭头',
  path: '路径',
  freedraw: '手绘笔触',
  text: '文字',
  latex: '公式',
  image: '图片',
  plot: '函数图像',
  construct: '几何构造',
};

/* ------------------------------------------------------------------ *
 * update / delete —— 权限检查在这里
 * ------------------------------------------------------------------ */

export const execUpdate: ToolExecutor = async (raw, ctx) => {
  const a = canvasUpdate.input.parse(raw);

  const missing = a.patches.filter((p) => !ctx.scene.has(p.id)).map((p) => p.id);
  if (missing.length > 0) {
    return err(`这些图元不存在：${missing.join(', ')}`, '先 canvas_query 确认 id。用户可能已经删掉了它们。');
  }

  const blocked = a.patches
    .map((p) => ctx.scene.get(p.id)!)
    .filter((s) => !checkWritable(s.layer, ctx, a.force).allowed);

  if (blocked.length > 0) {
    const guard = checkWritable('user', ctx, a.force) as { error: string; hint: string };
    return err(`${blocked.length} 个图元属于用户，${guard.error}`, guard.hint);
  }

  const diff = ctx.scene.update(a.patches, { origin: 'ai' });
  return ok({ updated: diff.updated }, track(ctx, diff));
};

export const execDelete: ToolExecutor = async (raw, ctx) => {
  const a = canvasDelete.input.parse(raw);
  const shapes = a.ids.map((id) => ctx.scene.get(id)).filter(Boolean) as Shape[];

  const blocked = shapes.filter((s) => !checkWritable(s.layer, ctx, a.force).allowed);
  if (blocked.length > 0) {
    return err(
      `不能删除用户画的内容（${blocked.length} 个）`,
      '删除用户内容必须先经用户同意：用 interact_ask_user 确认，用户同意后会话会切到 direct 模式，再带 force:true 重试。',
    );
  }

  const diff = ctx.scene.delete(a.ids, { origin: 'ai' });
  return ok({ deleted: diff.deleted }, track(ctx, diff));
};

/* ------------------------------------------------------------------ *
 * transform / style
 * ------------------------------------------------------------------ */

export const execTransform: ToolExecutor = async (raw, ctx) => {
  const a = canvasTransform.input.parse(raw);
  const shapes = a.ids.map((id) => ctx.scene.get(id)).filter(Boolean) as Shape[];
  if (shapes.length === 0) return err('没有找到任何指定的图元', '先 canvas_query 拿到有效 id。');

  const blocked = shapes.filter((s) => !checkWritable(s.layer, ctx, false).allowed);
  if (blocked.length > 0) {
    const guard = checkWritable('user', ctx, false) as { error: string; hint: string };
    return err(guard.error, guard.hint);
  }

  const bounds = unionBounds(shapes.map(shapeBounds));
  const origin: Point =
    typeof a.origin === 'string'
      ? a.origin === 'center'
        ? rectCenter(bounds)
        : { x: bounds[0], y: bounds[1] }
      : a.origin;

  const sx = typeof a.scale === 'number' ? a.scale : a.scale?.x ?? 1;
  const sy = typeof a.scale === 'number' ? a.scale : a.scale?.y ?? 1;

  const patches = shapes.map((s) => {
    const set: Partial<Shape> = {};
    let x = s.x;
    let y = s.y;

    if (sx !== 1 || sy !== 1) {
      x = origin.x + (x - origin.x) * sx;
      y = origin.y + (y - origin.y) * sy;
      if (s.w !== undefined) set.w = s.w * sx;
      if (s.h !== undefined) set.h = s.h * sy;
      if (s.points) set.points = s.points.map((p) => [(p[0] ?? 0) * sx, (p[1] ?? 0) * sy] as [number, number]);
    }
    if (a.translate) {
      x += a.translate.x;
      y += a.translate.y;
    }
    if (a.rotate) set.rotation = (s.rotation + a.rotate) % 360;

    set.x = round(x, 2);
    set.y = round(y, 2);
    return { id: s.id, set };
  });

  const diff = ctx.scene.update(patches, { origin: 'ai' });
  return ok({ transformed: diff.updated }, track(ctx, diff));
};

export const execStyle: ToolExecutor = async (raw, ctx) => {
  const a = canvasStyle.input.parse(raw);
  const shapes = a.ids.map((id) => ctx.scene.get(id)).filter(Boolean) as Shape[];
  const blocked = shapes.filter((s) => !checkWritable(s.layer, ctx, false).allowed);
  if (blocked.length > 0) {
    const guard = checkWritable('user', ctx, false) as { error: string; hint: string };
    return err(guard.error, guard.hint);
  }
  const diff = ctx.scene.update(shapes.map((s) => ({ id: s.id, set: { style: a.style } })), { origin: 'ai' });
  return ok({ styled: diff.updated }, track(ctx, diff));
};

/* ------------------------------------------------------------------ *
 * group / align / distribute
 * ------------------------------------------------------------------ */

export const execGroup: ToolExecutor = async (raw, ctx) => {
  const a = canvasGroup.input.parse(raw);
  const shapes = a.ids.map((id) => ctx.scene.get(id)).filter(Boolean) as Shape[];
  if (shapes.length < 2) return err('编组至少需要 2 个存在的图元', '先 canvas_query 确认 id 都有效。');

  const b = unionBounds(shapes.map(shapeBounds));
  const { ids, diff } = ctx.scene.create(
    [
      {
        type: 'group',
        x: b[0],
        y: b[1],
        w: b[2],
        h: b[3],
        children: a.ids,
        meta: a.name ? { label: a.name } : {},
      },
    ],
    { author: ctx.author },
  );
  return ok({ groupId: ids[0], members: a.ids }, track(ctx, diff));
};

export const execAlign: ToolExecutor = async (raw, ctx) => {
  const a = canvasAlign.input.parse(raw);
  const shapes = a.ids.map((id) => ctx.scene.get(id)).filter(Boolean) as Shape[];
  if (shapes.length < 2) return err('对齐至少需要 2 个存在的图元', '先 canvas_query 确认 id。');

  const rects = new Map(shapes.map((s) => [s.id, shapeBounds(s)] as const));
  const all = unionBounds([...rects.values()]);

  const patches = shapes.map((s) => {
    const r = rects.get(s.id)!;
    let dx = 0;
    let dy = 0;
    switch (a.axis) {
      case 'left': dx = all[0] - r[0]; break;
      case 'right': dx = all[0] + all[2] - (r[0] + r[2]); break;
      case 'hcenter': dx = all[0] + all[2] / 2 - (r[0] + r[2] / 2); break;
      case 'top': dy = all[1] - r[1]; break;
      case 'bottom': dy = all[1] + all[3] - (r[1] + r[3]); break;
      case 'vcenter': dy = all[1] + all[3] / 2 - (r[1] + r[3] / 2); break;
    }
    return { id: s.id, set: { x: round(s.x + dx, 2), y: round(s.y + dy, 2) } };
  });

  const diff = ctx.scene.update(patches, { origin: 'ai' });
  return ok({ aligned: diff.updated, axis: a.axis }, track(ctx, diff));
};

export const execDistribute: ToolExecutor = async (raw, ctx) => {
  const a = canvasDistribute.input.parse(raw);
  const shapes = (a.ids.map((id) => ctx.scene.get(id)).filter(Boolean) as Shape[]).sort((s1, s2) => {
    const b1 = shapeBounds(s1);
    const b2 = shapeBounds(s2);
    return a.axis === 'x' ? b1[0] - b2[0] : b1[1] - b2[1];
  });
  if (shapes.length < 3) return err('等距分布至少需要 3 个存在的图元', '两个图元之间无所谓"等距"，请检查 ids。');

  const rects = shapes.map((s) => shapeBounds(s));
  const i = a.axis === 'x' ? 0 : 1;
  const sizeIdx = a.axis === 'x' ? 2 : 3;

  const first = rects[0]!;
  const last = rects[rects.length - 1]!;
  const totalSize = rects.reduce((n, r) => n + r[sizeIdx], 0);
  const span = last[i] + last[sizeIdx] - first[i];
  const gap = a.gap ?? (span - totalSize) / (shapes.length - 1);

  let cursor = first[i];
  const patches = shapes.map((s, idx) => {
    const r = rects[idx]!;
    const delta = cursor - r[i];
    cursor += r[sizeIdx] + gap;
    return a.axis === 'x'
      ? { id: s.id, set: { x: round(s.x + delta, 2) } }
      : { id: s.id, set: { y: round(s.y + delta, 2) } };
  });

  const diff = ctx.scene.update(patches, { origin: 'ai' });
  return ok({ distributed: diff.updated, gap: round(gap, 2) }, track(ctx, diff));
};

/* ------------------------------------------------------------------ *
 * connect —— 带绑定的连线，两端移动时自动重算
 * ------------------------------------------------------------------ */

export const execConnect: ToolExecutor = async (raw, ctx) => {
  const a = canvasConnect.input.parse(raw);

  const resolve = (r: unknown): { shape?: Shape; point?: Point; anchor: string } => {
    if (typeof r === 'string') return { shape: ctx.scene.get(r), anchor: 'auto' };
    if (typeof r === 'object' && r && 'id' in r) {
      return { shape: ctx.scene.get((r as { id: string }).id), anchor: (r as { anchor?: string }).anchor ?? 'auto' };
    }
    return { point: r as Point, anchor: 'auto' };
  };

  const from = resolve(a.from);
  const to = resolve(a.to);
  if (!from.shape && !from.point) return err('from 无法解析', '传图元 id 或 {x,y}，先用 canvas_query 确认 id。');
  if (!to.shape && !to.point) return err('to 无法解析', '传图元 id 或 {x,y}，先用 canvas_query 确认 id。');

  const cFrom = from.point ?? rectCenter(shapeBounds(from.shape!));
  const cTo = to.point ?? rectCenter(shapeBounds(to.shape!));
  const p1 = from.shape ? anchorOn(shapeBounds(from.shape), from.anchor, cTo) : cFrom;
  const p2 = to.shape ? anchorOn(shapeBounds(to.shape), to.anchor, cFrom) : cTo;

  const points: Array<[number, number]> =
    a.routing === 'ortho'
      ? [[0, 0], [round((p2.x - p1.x) / 2, 1), 0], [round((p2.x - p1.x) / 2, 1), round(p2.y - p1.y, 1)], [round(p2.x - p1.x, 1), round(p2.y - p1.y, 1)]]
      : [[0, 0], [round(p2.x - p1.x, 1), round(p2.y - p1.y, 1)]];

  const shapeInput = {
    type: a.kind as 'arrow' | 'line',
    x: round(p1.x, 1),
    y: round(p1.y, 1),
    points,
    style: { arrowEnd: a.kind === 'arrow', ...(a.style ?? {}) },
    meta: { role: 'connector' },
    ...(from.shape ? { bindStart: { shapeId: from.shape.id, anchor: from.anchor as 'auto' } } : {}),
    ...(to.shape ? { bindEnd: { shapeId: to.shape.id, anchor: to.anchor as 'auto' } } : {}),
  };

  const created = ctx.scene.create([shapeInput], { author: ctx.author });
  const ids = [...created.ids];

  if (a.label) {
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const lbl = ctx.scene.create(
      [{ type: 'text', x: round(mid.x, 1), y: round(mid.y - 8, 1), text: a.label, style: { fontSize: 13 }, meta: { role: 'connector-label', refs: [created.ids[0]!] } }],
      { author: ctx.author, opId: created.diff.opId },
    );
    ids.push(...lbl.ids);
  }

  return ok({ ids, from: p1, to: p2 }, track(ctx, { ...created.diff, created: ids }));
};

/** auto 锚点：朝向对方的那条边的中点 */
function anchorOn(r: Rect, anchor: string, toward: Point): Point {
  const c = rectCenter(r);
  if (anchor === 'center') return c;
  if (anchor === 'top') return { x: c.x, y: r[1] };
  if (anchor === 'bottom') return { x: c.x, y: r[1] + r[3] };
  if (anchor === 'left') return { x: r[0], y: c.y };
  if (anchor === 'right') return { x: r[0] + r[2], y: c.y };

  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (Math.abs(dx) * r[3] > Math.abs(dy) * r[2]) {
    return { x: dx > 0 ? r[0] + r[2] : r[0], y: c.y };
  }
  return { x: c.x, y: dy > 0 ? r[1] + r[3] : r[1] };
}

/* ------------------------------------------------------------------ *
 * ink / erase / layer
 * ------------------------------------------------------------------ */

export const execInk: ToolExecutor = async (raw, ctx) => {
  const a = canvasInk.input.parse(raw);
  const layer = defaultLayer(ctx, a.layer);
  const guard = checkWritable(layer, ctx, false);
  if (!guard.allowed) return err(guard.error, guard.hint);

  const [ox, oy] = [a.points[0]![0], a.points[0]![1]];
  const rel = a.points.map((p) => [round(p[0] - ox, 1), round(p[1] - oy, 1)] as [number, number]);

  const { ids, diff } = ctx.scene.create(
    [{ type: 'freedraw', x: ox, y: oy, points: rel, style: a.style ?? {}, meta: (a.meta ?? {}) as Shape['meta'] }],
    { author: ctx.author, layer },
  );
  return ok({ ids, points: a.points.length }, track(ctx, diff));
};

export const execErase: ToolExecutor = async (raw, ctx) => {
  const a = canvasErase.input.parse(raw);
  const targets = ctx.scene
    .inRegion(a.region as Rect)
    .filter((s) => (a.layer ? s.layer === a.layer : s.layer !== 'user'))
    .filter((s) => checkWritable(s.layer, ctx, false).allowed);

  if (targets.length === 0) return ok({ deleted: [], note: '该区域内没有你有权限删除的内容' });
  const diff = ctx.scene.delete(targets.map((s) => s.id), { origin: 'ai' });
  return ok({ deleted: diff.deleted }, track(ctx, diff));
};

export const execLayerSetVisible: ToolExecutor = async (raw, ctx) => {
  const a = canvasLayerSetVisible.input.parse(raw);
  ctx.scene.setLayerState(a.id, { visible: a.visible }, 'ai');
  return ok({ layer: a.id, visible: a.visible });
};

export const execLayerClear: ToolExecutor = async (raw, ctx) => {
  const a = canvasLayerClear.input.parse(raw);
  if (a.id === 'user') {
    return err('不能清空 user 图层', '那是用户的作品。你只能清空 ai / annot / suggest 图层。');
  }
  const diff = ctx.scene.clearLayer(a.id, 'ai');
  return ok({ cleared: diff.deleted.length }, track(ctx, diff));
};

export const _newOpId = newOpId;
