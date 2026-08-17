import type { Point, Rect, Relation, Shape } from '@canvai/protocol';

/* ------------------------------------------------------------------ *
 * 约定
 *   rect / ellipse / image / text / latex / plot : (x,y) = 包围盒左上角，w/h 为尺寸
 *   line / arrow / polygon / path / freedraw     : points 相对于 (x,y)
 * ------------------------------------------------------------------ */

export const EPS = 1e-6;

export const pt = (x: number, y: number): Point => ({ x, y });

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 角度制，[0, 360) */
export function toDeg(rad: number): number {
  const d = (rad * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
}

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/* ------------------------------------------------------------------ *
 * 点序列
 * ------------------------------------------------------------------ */

/** 取图元的绝对坐标点序列；无点序列的图元返回包围盒四角 */
export function shapePoints(s: Shape): Point[] {
  if (s.points && s.points.length > 0) {
    return s.points.map((p) => rotateAbout(pt(s.x + (p[0] ?? 0), s.y + (p[1] ?? 0)), pt(s.x, s.y), s.rotation));
  }
  const [x, y, w, h] = shapeBounds(s);
  return [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h)];
}

export function rotateAbout(p: Point, origin: Point, deg: number): Point {
  if (!deg) return p;
  const r = toRad(deg);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return pt(origin.x + dx * cos - dy * sin, origin.y + dx * sin + dy * cos);
}

/* ------------------------------------------------------------------ *
 * 包围盒
 * ------------------------------------------------------------------ */

export function shapeBounds(s: Shape): Rect {
  if (s.points && s.points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of s.points) {
      const q = rotateAbout(pt(s.x + (p[0] ?? 0), s.y + (p[1] ?? 0)), pt(s.x, s.y), s.rotation);
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    // 线宽也占地方，向外扩半个线宽
    const pad = (s.style.strokeWidth ?? 2) / 2;
    return [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2];
  }

  const w = s.w ?? estimateTextWidth(s);
  const h = s.h ?? estimateTextHeight(s);
  if (!s.rotation) return [s.x, s.y, w, h];

  const c = pt(s.x + w / 2, s.y + h / 2);
  const corners = [pt(s.x, s.y), pt(s.x + w, s.y), pt(s.x + w, s.y + h), pt(s.x, s.y + h)].map((p) =>
    rotateAbout(p, c, s.rotation),
  );
  return boundsOfPoints(corners);
}

function estimateTextWidth(s: Shape): number {
  if (s.type !== 'text' && s.type !== 'latex') return 0;
  const fs = s.style.fontSize ?? 16;
  // 粗估：CJK 按 1em，ASCII 按 0.55em。服务端无字体度量，够用即可。
  let units = 0;
  for (const ch of s.text ?? '') units += ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55;
  return units * fs;
}

function estimateTextHeight(s: Shape): number {
  if (s.type !== 'text' && s.type !== 'latex') return 0;
  const fs = s.style.fontSize ?? 16;
  const lines = (s.text ?? '').split('\n').length;
  return lines * fs * 1.4;
}

export function boundsOfPoints(points: Point[]): Rect {
  if (points.length === 0) return [0, 0, 0, 0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

export function unionBounds(rects: Rect[]): Rect {
  if (rects.length === 0) return [0, 0, 0, 0];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y, w, h] of rects) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

export const rectCenter = ([x, y, w, h]: Rect): Point => pt(x + w / 2, y + h / 2);

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a[0] + a[2] < b[0] || b[0] + b[2] < a[0] || a[1] + a[3] < b[1] || b[1] + b[3] < a[1]);
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    outer[0] <= inner[0] + EPS &&
    outer[1] <= inner[1] + EPS &&
    outer[0] + outer[2] >= inner[0] + inner[2] - EPS &&
    outer[1] + outer[3] >= inner[1] + inner[3] - EPS
  );
}

export function rectContainsPoint(r: Rect, p: Point, pad = 0): boolean {
  return p.x >= r[0] - pad && p.x <= r[0] + r[2] + pad && p.y >= r[1] - pad && p.y <= r[1] + r[3] + pad;
}

/** 矩形间最短距离，相交时为 0 */
export function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a[0] - (b[0] + b[2]), b[0] - (a[0] + a[2])));
  const dy = Math.max(0, Math.max(a[1] - (b[1] + b[3]), b[1] - (a[1] + a[3])));
  return Math.hypot(dx, dy);
}

/* ------------------------------------------------------------------ *
 * 线段
 * ------------------------------------------------------------------ */

export interface Segment {
  a: Point;
  b: Point;
}

export function shapeSegments(s: Shape): Segment[] {
  const pts = shapePoints(s);
  const segs: Segment[] = [];
  for (let i = 0; i + 1 < pts.length; i++) segs.push({ a: pts[i]!, b: pts[i + 1]! });
  const closed = s.closed ?? s.type === 'polygon';
  if (closed && pts.length > 2) segs.push({ a: pts[pts.length - 1]!, b: pts[0]! });
  return segs;
}

/** 线段方向角，[0, 180)，用于平行/垂直判断 */
export function segmentAngle(s: Segment): number {
  const d = toDeg(Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x));
  return d % 180;
}

export function segmentLength(s: Segment): number {
  return distance(s.a, s.b);
}

export function polylineLength(points: Point[]): number {
  let n = 0;
  for (let i = 0; i + 1 < points.length; i++) n += distance(points[i]!, points[i + 1]!);
  return n;
}

/** 两线段交点；平行或不相交返回 null */
export function segmentIntersection(s1: Segment, s2: Segment): Point | null {
  const x1 = s1.a.x;
  const y1 = s1.a.y;
  const x2 = s1.b.x;
  const y2 = s1.b.y;
  const x3 = s2.a.x;
  const y3 = s2.a.y;
  const x4 = s2.b.x;
  const y4 = s2.b.y;

  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < EPS) return null;

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;

  return pt(x1 + t * (x2 - x1), y1 + t * (y2 - y1));
}

/** 点到线段的最近距离 */
export function pointToSegment(p: Point, s: Segment): number {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return distance(p, s.a);
  let t = ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return distance(p, pt(s.a.x + t * dx, s.a.y + t * dy));
}

/** 三点夹角（b 为顶点），角度制 */
export function angleAt(a: Point, b: Point, c: Point): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const m1 = Math.hypot(v1.x, v1.y);
  const m2 = Math.hypot(v2.x, v2.y);
  if (m1 < EPS || m2 < EPS) return 0;
  const cos = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (m1 * m2)));
  return toDeg(Math.acos(cos));
}

/** 多边形面积（鞋带公式），绝对值 */
export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function shapeArea(s: Shape): number {
  if (s.type === 'ellipse') {
    const [, , w, h] = shapeBounds(s);
    return (Math.PI * w * h) / 4;
  }
  if (s.points && s.points.length >= 3) return polygonArea(shapePoints(s));
  const [, , w, h] = shapeBounds(s);
  return w * h;
}

/** 图元命中测试：填充图元测包围盒，线状图元测到笔画的距离 */
export function hitTestShape(s: Shape, p: Point, radius: number): boolean {
  const tol = radius + (s.style.strokeWidth ?? 2) / 2;
  if (s.type === 'line' || s.type === 'arrow' || s.type === 'path' || s.type === 'freedraw') {
    return shapeSegments(s).some((seg) => pointToSegment(p, seg) <= tol);
  }
  if (s.type === 'polygon' && !s.style.fill) {
    return shapeSegments(s).some((seg) => pointToSegment(p, seg) <= tol);
  }
  if (s.type === 'ellipse') {
    const [x, y, w, h] = shapeBounds(s);
    if (w < EPS || h < EPS) return false;
    const nx = (p.x - (x + w / 2)) / (w / 2 + tol);
    const ny = (p.y - (y + h / 2)) / (h / 2 + tol);
    return nx * nx + ny * ny <= 1;
  }
  return rectContainsPoint(shapeBounds(s), p, tol);
}

/* ------------------------------------------------------------------ *
 * 空间关系 —— 让 Agent "看懂"图形怎么摆放的核心
 * ------------------------------------------------------------------ */

export interface RelationOptions {
  /** 视为"相邻"的间距阈值 */
  touchGap?: number;
  /** 平行/垂直的角度容差 */
  angleTol?: number;
  /** 对齐的坐标容差 */
  alignTol?: number;
}

export function computeRelations(shapes: Shape[], opts: RelationOptions = {}): Relation[] {
  const touchGap = opts.touchGap ?? 8;
  const angleTol = opts.angleTol ?? 5;
  const alignTol = opts.alignTol ?? 4;

  const out: Relation[] = [];
  const bounds = new Map<string, Rect>(shapes.map((s) => [s.id, shapeBounds(s)]));

  const isLinear = (s: Shape) => s.type === 'line' || s.type === 'arrow';

  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i]!;
      const b = shapes[j]!;
      const ra = bounds.get(a.id)!;
      const rb = bounds.get(b.id)!;

      if (rectContains(ra, rb)) out.push({ a: a.id, b: b.id, kind: 'contains' });
      else if (rectContains(rb, ra)) out.push({ a: a.id, b: b.id, kind: 'inside' });
      else if (rectsIntersect(ra, rb)) {
        const hit = shapeSegments(a).some((s1) =>
          shapeSegments(b).some((s2) => segmentIntersection(s1, s2) !== null),
        );
        out.push({ a: a.id, b: b.id, kind: hit ? 'intersects' : 'touches' });
      } else {
        const gap = rectDistance(ra, rb);
        if (gap <= touchGap) out.push({ a: a.id, b: b.id, kind: 'touches', value: round(gap) });
      }

      // 方位：带 touchGap 容差 —— 屋顶正好贴在墙上时，语义上仍然是"在上方"，
      // 严格不等式会把这种最常见的情况判掉。
      const ca = rectCenter(ra);
      const cb = rectCenter(rb);
      const gapAbove = (over: Rect, under: Rect) => round(Math.max(0, under[1] - over[1] - over[3]));
      const gapLeft = (l: Rect, r: Rect) => round(Math.max(0, r[0] - l[0] - l[2]));

      if (rb[1] + rb[3] <= ra[1] + touchGap) out.push({ a: b.id, b: a.id, kind: 'above', value: gapAbove(rb, ra) });
      else if (ra[1] + ra[3] <= rb[1] + touchGap) out.push({ a: a.id, b: b.id, kind: 'above', value: gapAbove(ra, rb) });
      if (rb[0] + rb[2] <= ra[0] + touchGap) out.push({ a: b.id, b: a.id, kind: 'left-of', value: gapLeft(rb, ra) });
      else if (ra[0] + ra[2] <= rb[0] + touchGap) out.push({ a: a.id, b: b.id, kind: 'left-of', value: gapLeft(ra, rb) });

      // 对齐
      if (Math.abs(ca.x - cb.x) <= alignTol) out.push({ a: a.id, b: b.id, kind: 'aligned-x' });
      if (Math.abs(ca.y - cb.y) <= alignTol) out.push({ a: a.id, b: b.id, kind: 'aligned-y' });

      // 平行/垂直：只对线段类图元判断
      if (isLinear(a) && isLinear(b)) {
        const d = Math.abs(segmentAngle(shapeSegments(a)[0] ?? { a: ca, b: ca }) - segmentAngle(shapeSegments(b)[0] ?? { a: cb, b: cb }));
        const diff = Math.min(d, 180 - d);
        if (diff <= angleTol) out.push({ a: a.id, b: b.id, kind: 'parallel', value: round(diff) });
        else if (Math.abs(diff - 90) <= angleTol) out.push({ a: a.id, b: b.id, kind: 'perpendicular', value: round(diff) });
      }
    }
  }
  return out;
}

export const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
