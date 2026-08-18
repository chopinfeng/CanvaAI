import type { ShapeInput } from '@canvai/protocol';

/**
 * 声明式几何图形构建器。
 *
 * 手写几十组线段和标签坐标必然出错，而错了很难一眼看出来。
 * 这里只声明「点在哪、连哪些边」，标签自动往图形外侧摆，
 * 直角标记和圆也一并生成。数学坐标 y 向上，转画布时统一翻转。
 */

export interface FigureSpec {
  /** 每单位多少像素 */
  unit: number;
  /** 命名点，数学坐标（y 向上） */
  pts: Record<string, readonly [number, number]>;
  /** 连线。'AB' 表示连 A、B；要样式就用元组形式 */
  edges: Array<string | readonly [string, string, EdgeStyle]>;
  /** 直角标记：[顶点, 方向点1, 方向点2] */
  rightAngles?: Array<readonly [string, string, string]>;
  /** 圆：圆心点名 + 半径（单位同 pts） */
  circles?: Array<{ at: string; r: number; color?: string; dash?: number[] }>;
  /** 曲线：函数图象之类，直接给采样点（数学坐标） */
  curves?: Array<{ points: Array<readonly [number, number]>; color?: string; width?: number; label?: string }>;
  /** 矩形：左上角点名 + 宽高（单位同 pts）。比连四条边省事，也不会漏边 */
  rects?: Array<{ at: string; w: number; h: number; color?: string; width?: number }>;
  /** 不想标注的点（如辅助计算用的点） */
  hide?: string[];
  /** 边长/角度等额外标注，位置用数学坐标 */
  notes?: Array<{ at: readonly [number, number]; text: string; color?: string; size?: number }>;
}

export interface EdgeStyle {
  color?: string;
  dash?: number[];
  width?: number;
}

const INK = '#1c1917';
const AUX = '#2563eb';

/**
 * 标签往「远离图形重心」的方向偏移，避免压在线上。
 * 简单但对这类教科书图形足够——真出现重叠时人一眼能看出来，再手动调 notes。
 */
function labelOffset(p: readonly [number, number], centroid: [number, number]): [number, number] {
  const dx = p[0] - centroid[0];
  const dy = p[1] - centroid[1];
  const len = Math.hypot(dx, dy) || 1;
  return [(dx / len) * 20 - 5, -(dy / len) * 20 - 7];
}

export function buildFigure(spec: FigureSpec, origin: { x: number; y: number }): ShapeInput[] {
  const { unit } = spec;
  const toCanvas = (p: readonly [number, number]): [number, number] => [
    origin.x + p[0] * unit,
    origin.y - p[1] * unit,
  ];

  const names = Object.keys(spec.pts);
  const cx = names.reduce((a, n) => a + spec.pts[n]![0], 0) / Math.max(1, names.length);
  const cy = names.reduce((a, n) => a + spec.pts[n]![1], 0) / Math.max(1, names.length);
  const centroid: [number, number] = [cx, cy];

  const out: ShapeInput[] = [];

  /* ---- 圆 ---- */
  for (const c of spec.circles ?? []) {
    const at = spec.pts[c.at];
    if (!at) throw new Error(`圆心 ${c.at} 不在 pts 里`);
    const [px, py] = toCanvas([at[0] - c.r, at[1] + c.r]);
    out.push({
      type: 'ellipse',
      x: px,
      y: py,
      w: c.r * 2 * unit,
      h: c.r * 2 * unit,
      style: { stroke: c.color ?? INK, strokeWidth: 1.8, ...(c.dash ? { dash: c.dash } : {}) },
      meta: { role: 'circle' },
    });
  }

  /* ---- 矩形 ---- */
  for (const r of spec.rects ?? []) {
    const at = spec.pts[r.at];
    if (!at) throw new Error(`矩形锚点 ${r.at} 不在 pts 里`);
    const [px, py] = toCanvas(at);
    out.push({
      type: 'rect',
      x: px,
      y: py,
      w: r.w * unit,
      h: r.h * unit,
      style: { stroke: r.color ?? INK, strokeWidth: r.width ?? 2 },
      meta: { role: 'figure-rect' },
    });
  }

  /* ---- 曲线 ---- */
  for (const c of spec.curves ?? []) {
    if (c.points.length < 2) continue;
    out.push({
      type: 'path',
      points: c.points.map(toCanvas),
      style: { stroke: c.color ?? AUX, strokeWidth: c.width ?? 2 },
      meta: { role: 'curve', ...(c.label ? { label: c.label } : {}) },
    });
  }

  /* ---- 边 ---- */
  for (const e of spec.edges) {
    const [a, b, style] = typeof e === 'string' ? [e[0]!, e[1]!, undefined] : e;
    const pa = spec.pts[a];
    const pb = spec.pts[b];
    if (!pa || !pb) throw new Error(`边 ${a}${b} 的端点不在 pts 里`);
    out.push({
      type: 'line',
      points: [toCanvas(pa), toCanvas(pb)],
      style: {
        stroke: style?.color ?? INK,
        strokeWidth: style?.width ?? 2,
        ...(style?.dash ? { dash: style.dash } : {}),
      },
      meta: { role: 'figure-edge', label: `${a}${b}` },
    });
  }

  /* ---- 直角标记 ---- */
  for (const [v, d1, d2] of spec.rightAngles ?? []) {
    const pv = spec.pts[v];
    const p1 = spec.pts[d1];
    const p2 = spec.pts[d2];
    if (!pv || !p1 || !p2) throw new Error(`直角标记 ${v} 的点不在 pts 里`);
    const u1 = unitVec(pv, p1);
    const u2 = unitVec(pv, p2);
    const s = 12 / unit; // 标记边长（数学单位）
    const a: [number, number] = [pv[0] + u1[0] * s, pv[1] + u1[1] * s];
    const c: [number, number] = [pv[0] + u2[0] * s, pv[1] + u2[1] * s];
    const b: [number, number] = [a[0] + u2[0] * s, a[1] + u2[1] * s];
    out.push({
      type: 'path',
      points: [toCanvas(a), toCanvas(b), toCanvas(c)],
      style: { stroke: INK, strokeWidth: 1.4 },
      meta: { role: 'right-angle' },
    });
  }

  /* ---- 点标签 ---- */
  const hidden = new Set(spec.hide ?? []);
  for (const n of names) {
    if (hidden.has(n)) continue;
    const p = spec.pts[n]!;
    const [bx, by] = toCanvas(p);
    const [ox, oy] = labelOffset(p, centroid);
    out.push({
      type: 'text',
      x: bx + ox,
      y: by + oy,
      text: n,
      style: { stroke: INK, fontSize: 15 },
      meta: { role: 'vertex-label', label: n },
    });
  }

  /* ---- 额外标注 ---- */
  for (const note of spec.notes ?? []) {
    const [bx, by] = toCanvas(note.at);
    out.push({
      type: 'text',
      x: bx,
      y: by,
      text: note.text,
      style: { stroke: note.color ?? '#78716c', fontSize: note.size ?? 13 },
      meta: { role: 'measure-label' },
    });
  }

  return out;
}

function unitVec(from: readonly [number, number], to: readonly [number, number]): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

export const COLORS = { INK, AUX, RED: '#dc2626', GREEN: '#059669', GRAY: '#78716c' };
