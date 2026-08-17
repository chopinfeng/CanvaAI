import {
  boundsOfPoints,
  computeRelations,
  distance,
  hitTestShape,
  polylineLength,
  pt,
  rectCenter,
  rectsIntersect,
  round,
  sceneToSvg,
  segmentIntersection,
  shapeArea,
  shapeBounds,
  shapePoints,
  shapeSegments,
} from '@canvai/canvas-core';
import type { Point, Rect, Shape } from '@canvai/protocol';
import {
  canvasDescribe,
  canvasGetSelection,
  canvasGetViewport,
  canvasHitTest,
  canvasMeasure,
  canvasQuery,
  canvasSnapshot,
  err,
  ok,
} from '@canvai/protocol';
import type { ToolContext, ToolExecutor } from './context.js';

/* ------------------------------------------------------------------ *
 * canvas_query —— 渐进披露的第一级：只给摘要
 * ------------------------------------------------------------------ */

export const execQuery: ToolExecutor = async (raw, ctx) => {
  const a = canvasQuery.input.parse(raw);
  let shapes = ctx.scene.all();

  if (a.type) shapes = shapes.filter((s) => a.type!.includes(s.type));
  if (a.layer) shapes = shapes.filter((s) => a.layer!.includes(s.layer));
  if (a.role) shapes = shapes.filter((s) => s.meta.role && a.role!.includes(s.meta.role));
  if (a.text) shapes = shapes.filter((s) => s.text?.includes(a.text!));
  if (a.region) shapes = shapes.filter((s) => rectsIntersect(shapeBounds(s), a.region as Rect));

  if (a.near) {
    const anchor = ctx.scene.get(a.near.id);
    if (!anchor) {
      return err(`找不到图元 ${a.near.id}`, '先调用 canvas_query 不带 near 参数，确认画布上有哪些图元 id。');
    }
    const ab = shapeBounds(anchor);
    shapes = shapes.filter((s) => s.id !== a.near!.id && rectDistanceTo(ab, shapeBounds(s)) <= a.near!.within);
  }

  const total = shapes.length;
  const page = shapes.slice(0, a.limit);
  return ok({
    shapes: page.map((s) => ctx.scene.brief(s)),
    total,
    truncated: total > page.length,
  });
};

/* ------------------------------------------------------------------ *
 * canvas_describe —— 第二级：完整几何 + 空间关系
 * ------------------------------------------------------------------ */

export const execDescribe: ToolExecutor = async (raw, ctx) => {
  const a = canvasDescribe.input.parse(raw);

  let shapes: Shape[];
  if (a.ids && a.ids.length > 0) {
    const missing = a.ids.filter((id) => !ctx.scene.has(id));
    if (missing.length > 0) {
      return err(
        `这些 id 不存在：${missing.join(', ')}`,
        '先用 canvas_query 拿到当前画布上真实存在的 id 再来描述。图元可能已被用户删除。',
      );
    }
    shapes = a.ids.map((id) => ctx.scene.get(id)!);
  } else if (a.region) {
    shapes = ctx.scene.inRegion(a.region as Rect);
  } else {
    shapes = ctx.scene.all();
  }

  if (shapes.length > 60) {
    return err(
      `一次要描述 ${shapes.length} 个图元，太多了`,
      '用 region 或 ids 缩小范围。先 canvas_query 看全局，再挑关心的几个 describe。',
    );
  }

  const data: Record<string, unknown> = {
    shapes: a.detail === 'brief' ? shapes.map((s) => ctx.scene.brief(s)) : shapes.map(compactShape),
  };
  if (a.relations) data.relations = computeRelations(shapes);
  return ok(data);
};

/** 去掉对模型无意义的字段，省 token */
function compactShape(s: Shape): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: s.id,
    type: s.type,
    layer: s.layer,
    bbox: shapeBounds(s).map((n) => round(n, 1)),
    author: s.author.kind,
  };
  if (s.points) out.points = s.points.map((p) => [round(s.x + (p[0] ?? 0), 1), round(s.y + (p[1] ?? 0), 1)]);
  else out.pos = { x: round(s.x, 1), y: round(s.y, 1), w: round(s.w ?? 0, 1), h: round(s.h ?? 0, 1) };
  if (s.rotation) out.rotation = s.rotation;
  if (s.text) out.text = s.text;
  if (s.closed !== undefined) out.closed = s.closed;
  if (Object.keys(s.style).length > 0) out.style = s.style;
  if (Object.keys(s.meta).length > 0) out.meta = s.meta;
  if (s.constraint) out.constraint = s.constraint;
  return out;
}

/* ------------------------------------------------------------------ *
 * canvas_measure —— 不让模型心算
 * ------------------------------------------------------------------ */

export const execMeasure: ToolExecutor = async (raw, ctx) => {
  const a = canvasMeasure.input.parse(raw);

  const resolveShape = (r: unknown): Shape | undefined =>
    typeof r === 'string' ? ctx.scene.get(r) : typeof r === 'object' && r && 'id' in r ? ctx.scene.get((r as { id: string }).id) : undefined;

  const resolvePoint = (r: unknown): Point | undefined => {
    if (typeof r === 'object' && r && 'x' in r && 'y' in r) return r as Point;
    const s = resolveShape(r);
    if (!s) return undefined;
    const anchor = typeof r === 'object' && r && 'anchor' in r ? (r as { anchor: string }).anchor : 'center';
    const b = shapeBounds(s);
    const pts = shapePoints(s);
    switch (anchor) {
      case 'start': return pts[0];
      case 'end': return pts[pts.length - 1];
      case 'top': return pt(b[0] + b[2] / 2, b[1]);
      case 'bottom': return pt(b[0] + b[2] / 2, b[1] + b[3]);
      case 'left': return pt(b[0], b[1] + b[3] / 2);
      case 'right': return pt(b[0] + b[2], b[1] + b[3] / 2);
      default: return rectCenter(b);
    }
  };

  const notFound = (which: string) =>
    err(`无法解析引用 ${which}`, '引用可以是图元 id、{x,y} 坐标、或 {id, anchor}。先用 canvas_query 确认 id 存在。');

  switch (a.what) {
    case 'distance': {
      if (a.b === undefined) return err('distance 需要两个引用', '补上参数 b。');
      const p1 = resolvePoint(a.a);
      const p2 = resolvePoint(a.b);
      if (!p1) return notFound('a');
      if (!p2) return notFound('b');
      return ok({ distance: round(distance(p1, p2)), from: p1, to: p2 });
    }

    case 'angle': {
      // 两个线状图元 → 夹角；否则按 a-b 连线与水平方向的夹角
      const sa = resolveShape(a.a);
      const sb = a.b !== undefined ? resolveShape(a.b) : undefined;
      if (sa && sb) {
        const g1 = shapeSegments(sa)[0];
        const g2 = shapeSegments(sb)[0];
        if (!g1 || !g2) return err('图元没有可用的线段', '角度测量需要线/箭头/多边形这类有点序列的图元。');
        const d1 = Math.atan2(g1.b.y - g1.a.y, g1.b.x - g1.a.x);
        const d2 = Math.atan2(g2.b.y - g2.a.y, g2.b.x - g2.a.x);
        let deg = Math.abs(((d1 - d2) * 180) / Math.PI) % 180;
        if (deg > 90) deg = 180 - deg;
        return ok({ angle: round(deg), unit: 'degree' });
      }
      const p1 = resolvePoint(a.a);
      const p2 = a.b !== undefined ? resolvePoint(a.b) : undefined;
      if (!p1 || !p2) return notFound('a/b');
      const deg = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
      return ok({ angle: round(deg < 0 ? deg + 360 : deg), unit: 'degree' });
    }

    case 'area': {
      const s = resolveShape(a.a);
      if (!s) return notFound('a');
      return ok({ area: round(shapeArea(s)) });
    }

    case 'length': {
      const s = resolveShape(a.a);
      if (!s) return notFound('a');
      return ok({ length: round(polylineLength(shapePoints(s))) });
    }

    case 'intersection': {
      if (a.b === undefined) return err('intersection 需要两个图元', '补上参数 b。');
      const s1 = resolveShape(a.a);
      const s2 = resolveShape(a.b);
      if (!s1) return notFound('a');
      if (!s2) return notFound('b');
      const hits: Point[] = [];
      for (const g1 of shapeSegments(s1)) {
        for (const g2 of shapeSegments(s2)) {
          const p = segmentIntersection(g1, g2);
          if (p) hits.push({ x: round(p.x), y: round(p.y) });
        }
      }
      return ok({ points: hits, count: hits.length });
    }

    case 'bbox': {
      const s = resolveShape(a.a);
      if (!s) return notFound('a');
      return ok({ bbox: shapeBounds(s).map((n) => round(n, 1)) });
    }

    default:
      return err(`未知的测量类型`, '可选：distance / angle / area / length / intersection / bbox。');
  }
};

/* ------------------------------------------------------------------ *
 * 其余只读工具
 * ------------------------------------------------------------------ */

export const execHitTest: ToolExecutor = async (raw, ctx) => {
  const a = canvasHitTest.input.parse(raw);
  const hits = ctx.scene.all().filter((s) => hitTestShape(s, a.point, a.radius));
  return ok({ shapes: hits.map((s) => ctx.scene.brief(s)) });
};

export const execGetSelection: ToolExecutor = async (_raw, ctx) => {
  const ids = ctx.session.selection;
  return ok({
    ids,
    shapes: ids.map((id) => ctx.scene.get(id)).filter(Boolean).map((s) => ctx.scene.brief(s!)),
  });
};

export const execGetViewport: ToolExecutor = async (_raw, ctx) => {
  const [x, y, w, h] = ctx.session.viewport;
  return ok({ viewport: { x: round(x), y: round(y), w: round(w), h: round(h) }, zoom: round(ctx.session.zoom, 3) });
};

/* ------------------------------------------------------------------ *
 * canvas_snapshot —— 视觉兜底
 * ------------------------------------------------------------------ */

export const execSnapshot: ToolExecutor = async (raw, ctx) => {
  const a = canvasSnapshot.input.parse(raw);
  const region = (a.region as Rect | undefined) ?? ctx.scene.contentBounds();
  if (region[2] <= 0 || region[3] <= 0) {
    return err('画布是空的，没有内容可截图', '先用 canvas_query 确认画布上有内容，空画布直接开始画就好。');
  }

  const svg = sceneToSvg(ctx.scene.all(), { region, scale: a.scale, annotateIds: true });

  if (!ctx.rasterizer) {
    // 没有光栅化器时退化成结构化描述，而不是直接失败
    const shapes = ctx.scene.inRegion(region);
    return ok({
      degraded: true,
      note: '当前环境没有配置图片渲染，已退化为结构化描述',
      shapes: shapes.map((s) => ctx.scene.brief(s)),
      relations: computeRelations(shapes),
    });
  }

  const png = await ctx.rasterizer.render(svg, a.scale);
  const assetId = ctx.assets ? await ctx.assets.put(png, 'image/png') : undefined;

  if (!a.describe || !ctx.vision) {
    return ok({ assetId, width: Math.round(region[2] * a.scale), height: Math.round(region[3] * a.scale) });
  }

  const description = await ctx.vision.describe(png, a.question);
  return ok({ assetId, description, region: region.map((n) => round(n, 1)) });
};

/* ------------------------------------------------------------------ */

function rectDistanceTo(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a[0] - (b[0] + b[2]), b[0] - (a[0] + a[2])));
  const dy = Math.max(0, Math.max(a[1] - (b[1] + b[3]), b[1] - (a[1] + a[3])));
  return Math.hypot(dx, dy);
}

export const _internal = { boundsOfPoints };
