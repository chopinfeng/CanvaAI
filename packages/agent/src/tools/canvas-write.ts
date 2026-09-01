import { newOpId, rectCenter, rectCrossedBySegment, round, shapeBounds, shapeSegments, unionBounds } from '@canvai/canvas-core';
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

  const resolved = a.shapes.map(absolutePointsToLocal);

  const collision = findTextCollision(ctx, resolved);
  if (collision) {
    return err(
      `新写的文字压住了已有的「${collision.meta.role ?? collision.type}」（${(collision.text ?? '').slice(0, 24)}）`,
      '落笔前先用 canvas_snapshot（region 传板书区，describe: true）看一眼板书写到哪儿了，' +
        '再决定这次接着往下还是往右写——自己心算坐标经常和实际渲染对不上。' +
        '矩形/线条盖住文字是"框起来"的正常用法（比如给答案画框），只有新文字压着旧文字才会被拦。',
    );
  }

  const crossing = findLineCrossing(ctx, resolved);
  if (crossing) {
    return err(
      `新写的文字被已有的「${crossing.meta.role ?? crossing.type}」这条线正中间穿过去了`,
      '这条线会把字划成两半，读不出来——不是"离图形太远"，是写的位置正好压在一条具体的边或' +
        '辅助线上。挪到旁边空白处几十像素，图形附近还有别的空当，不用完全避开这个图形。',
    );
  }

  const duplicate = findDuplicateText(ctx, resolved);
  if (duplicate) {
    return err(
      `这句话已经写在板书上了（「${duplicate.meta.role ?? duplicate.type}」，内容一字不差）`,
      '别把同一句话再写一遍——写过的东西不会因为挪个位置重写就变得更对。要强调已有的这一处，' +
        '用 canvas_highlight 指过去；真要写新内容，就换一句和已有内容不同的话。',
    );
  }

  const { ids, diff } = ctx.scene.create(resolved, {
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

/**
 * 新写的文字压没压住已有的文字。
 *
 * 真机录像复现过：提示词里反复讲了要先 canvas_snapshot 看一眼板书写到
 * 哪儿了、写完再核一遍不压already有的东西，模型整场一次都没调
 * canvas_snapshot，直接把新的一步写在了旧内容的正上方——画面上几行
 * 字叠成一团，一个字都读不出来。劝了没用，只能拦。
 *
 * 只查"新文字 vs 已有文字"：矩形/线条盖住文字是"框起来"的正常用法
 * （比如给最终答案画个框），不能拦；两块文字叠在一起才是真出问题，
 * 阈值定得比较低（重叠面积超过较小那块的 1/4）——文字块本来就该
 * 靠留白分开，沾一点边都不正常。
 */
function findTextCollision(ctx: ToolContext, shapes: ShapeInput[]): Shape | null {
  const newTexts = shapes.filter((s) => s.type === 'text' || s.type === 'latex');
  if (newTexts.length === 0) return null;

  const existingTexts = ctx.scene.all().filter((s) => s.type === 'text' || s.type === 'latex');
  if (existingTexts.length === 0) return null;

  for (const nt of newTexts) {
    // ShapeInputSchema 的 .partial({style:true}) 会把 style 的 .default({}) 短路掉——
    // 没传 style 的新图元这里拿到的是 undefined，不是 {}，shapeBounds 读 .fontSize 会炸。
    // 已经在场景里的图元走的是 ShapeSchema 本体，没有这个坑，不用补。
    const nb = shapeBounds({ ...nt, style: nt.style ?? {} } as Shape);
    const nArea = nb[2] * nb[3];
    if (nArea <= 0) continue;
    for (const et of existingTexts) {
      const eb = shapeBounds(et);
      const eArea = eb[2] * eb[3];
      if (eArea <= 0) continue;
      const overlap = rectOverlapArea(nb, eb);
      if (overlap / Math.min(nArea, eArea) > 0.25) return et;
    }
  }
  return null;
}

/**
 * 新写的文字有没有被一条已有的线（三角形的边、辅助线……）从中间划过去。
 *
 * 用户直接在板书截图里看出来的问题："这次的板书又覆盖到图形上了"——
 * "图案得挨着题目图形"那道闸只查包围盒相交，逼着模型把文字写进了
 * 三角形内部，结果新文字被三角形自己的边、高线正中间划了过去，读不出
 * 来。跟 findTextCollision 是两个不同方向的问题：那道检查看"新文字
 * 有没有压住旧文字"，这道检查看"新文字有没有被一条线条穿过"——挨着
 * 图形写没问题，写的位置正好被具体某条边划过去才是问题，纯包围盒
 * 重叠判断不出这个区别。
 */
function findLineCrossing(ctx: ToolContext, shapes: ShapeInput[]): Shape | null {
  const newTexts = shapes.filter((s) => s.type === 'text' || s.type === 'latex');
  if (newTexts.length === 0) return null;

  const existingLines = ctx.scene.all().filter((s) => s.points && s.points.length > 0);
  if (existingLines.length === 0) return null;

  for (const nt of newTexts) {
    const nb = shapeBounds({ ...nt, style: nt.style ?? {} } as Shape);
    if (nb[2] * nb[3] <= 0) continue;
    for (const line of existingLines) {
      if (shapeSegments(line).some((seg) => rectCrossedBySegment(nb, seg))) return line;
    }
  }
  return null;
}

/**
 * 新写的文字是不是和已经在板书上的某句一字不差。
 *
 * 真机复现（drill-g5-4）：diagramBlockCount 逼着模型往图形附近写一段真内容，
 * 那一片被图形本身的边和标签占得很满，新文字反复被 findTextCollision/
 * findLineCrossing 拦下；模型没有去修正坐标，而是每次换个新位置、一字不改地
 * 把同一句"最终结果：AD = 7，∠BFD = 60°"再写一遍——连写了 11 次，从图形正
 * 下方一路铺到画布外面去。两道碰撞检查都拦不住这个：11 份拷贝彼此隔得够开，
 * 谁都不挨着谁，没有一条会被判定为"压住"或"穿过"。得单独拦"同一句话又写了
 * 一遍"这件事，不能指望坐标碰撞检查顺带管到它。
 *
 * 只在 ai/annot 层内比较：题目原文（user 层）和 AI 复述题目用词接近很正常，
 * 不该被这道检查拦下。短标签（"60°"、"AB=13"这类）允许重复出现在图上不同
 * 位置，是真实存在的合理用法，所以只有字数够多的整句才查，不看单个数值/边标。
 */
function findDuplicateText(ctx: ToolContext, shapes: ShapeInput[]): Shape | null {
  const MIN_LEN = 8;
  const newTexts = shapes.filter((s) => (s.type === 'text' || s.type === 'latex') && (s.text?.trim().length ?? 0) >= MIN_LEN);
  if (newTexts.length === 0) return null;

  const existing = ctx.scene
    .all()
    .filter((s) => (s.type === 'text' || s.type === 'latex') && (s.layer === 'ai' || s.layer === 'annot'));
  if (existing.length === 0) return null;

  for (const nt of newTexts) {
    const norm = nt.text!.trim();
    const dup = existing.find((et) => (et.text ?? '').trim() === norm);
    if (dup) return dup;
  }
  return null;
}

function rectOverlapArea(a: Rect, b: Rect): number {
  const ox = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const oy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return ox * oy;
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
  /**
   * 辅导模式下不许清 ai / annot——那两层装的就是板书。
   *
   * 真机复现过两次：一次是被文字碰撞检测反复拒了之后，模型把这个工具
   * 当成逃生舱，说"我已经清除了之前的标记"；这次是被"图案得挨着题目
   * 图形"那道新闸拒了之后，模型说"我需要清理一些空间"，紧接着调了
   * 这个工具。板书区的内容是逐步累积的解题过程，不该被清掉——提示词
   * 里早就写着这条原则，但"卡住了就清空重来"显然靠劝是劝不住的。
   * `suggest` 图层不受影响：那是提案区，收拾提案没有这层顾虑。
   */
  if (ctx.session.mode === 'tutor' && (a.id === 'ai' || a.id === 'annot')) {
    return err(
      '辅导模式下不能清空板书区',
      `板书区（${a.id} 层）里是逐步累积的解题过程，清掉就等于把黑板擦了，学生看不见自己是怎么` +
        '一步步走到这儿的。觉得空间不够，用 canvas_zoom_to 把镜头挪开，或者往下 / 往旁边接着写，' +
        '不是清空重来。',
    );
  }
  const diff = ctx.scene.clearLayer(a.id, 'ai');
  return ok({ cleared: diff.deleted.length }, track(ctx, diff));
};

export const _newOpId = newOpId;
