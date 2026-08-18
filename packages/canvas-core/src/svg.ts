import type { Rect, Shape, Style } from '@canvai/protocol';
import { getStroke } from 'perfect-freehand';
import { rectsIntersect, shapeBounds, shapePoints, unionBounds } from './geometry.js';
import { sortForRender } from './scene.js';

/**
 * 场景 → SVG。
 *
 * 服务端没有浏览器，但 canvas_snapshot 需要给视觉模型喂图片：
 * 这里把场景序列化成 SVG，交给 resvg 光栅化。
 * 同一份代码也是前端导出 SVG/PNG 的实现。
 */

export interface SvgOptions {
  region?: Rect;
  padding?: number;
  background?: string;
  scale?: number;
  /** 只渲染这些图层 */
  layers?: string[];
  /** 在图元旁标注 id，给视觉模型定位用 */
  annotateIds?: boolean;
  /**
   * 把 assetId 换成可内嵌的 data URI。
   * canvas-core 不碰文件系统，所以由调用方（服务端）注入。
   * 不提供时图片会画成带标注的占位框——总比无声无息缺一块强。
   */
  resolveAsset?: (assetId: string) => string | undefined;
}

/**
 * 视口外图元的外扩容差：描边、箭头 marker、文字基线都会溢出包围盒一点，
 * 裁剪时留够余量，避免边缘图形被切掉。
 */
const CULL_MARGIN = 64;

export function sceneToSvg(shapes: Shape[], opts: SvgOptions = {}): string {
  const padding = opts.padding ?? 24;
  const scale = opts.scale ?? 1;
  const visible = opts.layers ? shapes.filter((s) => opts.layers!.includes(s.layer)) : shapes;
  const ordered = sortForRender(visible);

  const region: Rect =
    opts.region ??
    (ordered.length > 0
      ? expand(unionBounds(ordered.map(shapeBounds)), padding)
      : [0, 0, 800, 600]);

  /**
   * 只序列化与视口相交的图元。
   *
   * 这既是性能优化，也是**稳定性要求**：resvg 会为带 marker-end 或 opacity<1
   * 的元素分配离屏子画布，若该元素整个落在 viewBox 之外，它与视口求交得到
   * 空尺寸后 unwrap 了 None —— Rust panic 直接 abort 掉宿主进程。
   * 截一张 20×20 的局部图就能触发，而"放大看这个角落"是再普通不过的操作。
   * 渲染那端已经隔离到子进程兜底，这里从源头上不产生这种输入。
   */
  const cullRect: Rect = [
    region[0] - CULL_MARGIN,
    region[1] - CULL_MARGIN,
    region[2] + CULL_MARGIN * 2,
    region[3] + CULL_MARGIN * 2,
  ];
  const inView = ordered.filter((s) => rectsIntersect(shapeBounds(s), cullRect));

  const [rx, ry, rw, rh] = region;
  const w = Math.max(1, Math.round(rw * scale));
  const h = Math.max(1, Math.round(rh * scale));

  const body = inView.map((s) => shapeToSvg(s, opts)).filter(Boolean).join('\n  ');
  const bg = opts.background ?? '#ffffff';
  // defs 只出一次：早先每个箭头都带一份，同 id 重复是非法 SVG
  const defs = inView.some((s) => s.type === 'arrow') ? `\n  ${ARROW_DEFS}` : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${num(rx)} ${num(ry)} ${num(rw)} ${num(rh)}">`,
    `  <rect x="${num(rx)}" y="${num(ry)}" width="${num(rw)}" height="${num(rh)}" fill="${bg}"/>${defs}`,
    `  ${body}`,
    `</svg>`,
  ].join('\n');
}

function expand([x, y, w, h]: Rect, pad: number): Rect {
  return [x - pad, y - pad, w + pad * 2, h + pad * 2];
}

function shapeToSvg(s: Shape, opts: SvgOptions): string {
  const attrs = styleAttrs(s.style, s.type);
  const transform = s.rotation ? ` transform="rotate(${num(s.rotation)} ${num(s.x)} ${num(s.y)})"` : '';
  const label = opts.annotateIds ? idLabel(s) : '';

  switch (s.type) {
    case 'rect':
      return `<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.w ?? 0)}" height="${num(s.h ?? 0)}"${attrs}${transform}/>${label}`;

    case 'image': {
      const w = s.w ?? 0;
      const h = s.h ?? 0;
      const href = s.assetId ? opts.resolveAsset?.(s.assetId) : undefined;
      if (href) {
        return `<image x="${num(s.x)}" y="${num(s.y)}" width="${num(w)}" height="${num(h)}" href="${escapeXml(href)}" preserveAspectRatio="none"${transform}/>${label}`;
      }
      const note = s.meta.label ?? '图片';
      return (
        `<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(w)}" height="${num(h)}" fill="#f5f5f4" stroke="#d6d3d1" stroke-dasharray="6 4"/>` +
        `<text x="${num(s.x + w / 2)}" y="${num(s.y + h / 2)}" font-size="13" fill="#78716c" text-anchor="middle">[${escapeXml(String(note))}]</text>${label}`
      );
    }

    case 'ellipse': {
      const w = s.w ?? 0;
      const h = s.h ?? 0;
      return `<ellipse cx="${num(s.x + w / 2)}" cy="${num(s.y + h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}"${attrs}${transform}/>${label}`;
    }

    case 'line':
    case 'arrow':
    case 'polygon':
    case 'path':
    case 'plot':
    case 'construct': {
      const pts = shapePoints(s);
      if (pts.length < 2) return '';
      const d = toPathData(pts, s.closed ?? s.type === 'polygon');
      const marker = s.type === 'arrow' ? ` marker-end="url(#arrowhead)"` : '';
      return `<path d="${d}"${attrs}${marker}/>${label}`;
    }

    case 'freedraw': {
      const pts = shapePoints(s);
      if (pts.length < 2) return '';
      const outline = getStroke(
        pts.map((p) => [p.x, p.y]),
        { size: (s.style.strokeWidth ?? 3) * 2, thinning: 0.5, smoothing: 0.5, streamline: 0.5 },
      );
      const d = toPathData(outline.map(([x, y]) => ({ x: x ?? 0, y: y ?? 0 })), true);
      const fill = s.style.stroke ?? '#111827';
      return `<path d="${d}" fill="${fill}" opacity="${s.style.opacity ?? 1}"/>${label}`;
    }

    case 'text':
    case 'latex': {
      const fs = s.style.fontSize ?? 16;
      const fill = s.style.stroke ?? '#111827';
      const lines = (s.text ?? '').split('\n');
      const tspans = lines
        .map((ln, i) => `<tspan x="${num(s.x)}" dy="${i === 0 ? fs : fs * 1.4}">${escapeXml(ln)}</tspan>`)
        .join('');
      const family = s.style.fontFamily ?? 'system-ui, -apple-system, "PingFang SC", sans-serif';
      return `<text x="${num(s.x)}" y="${num(s.y)}" font-size="${num(fs)}" font-family="${escapeXml(family)}" fill="${fill}" opacity="${s.style.opacity ?? 1}"${transform}>${tspans}</text>${label}`;
    }

    case 'group':
      return '';

    default:
      return '';
  }
}

const ARROW_DEFS = `<defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="currentColor"/></marker></defs>`;

function idLabel(s: Shape): string {
  const [x, y] = shapeBounds(s);
  return `<text x="${num(x)}" y="${num(y - 4)}" font-size="10" fill="#ef4444" opacity="0.8">${escapeXml(s.id)}</text>`;
}

function toPathData(points: { x: number; y: number }[], closed: boolean): string {
  if (points.length === 0) return '';
  const head = points[0]!;
  let d = `M ${num(head.x)} ${num(head.y)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    d += ` L ${num(p.x)} ${num(p.y)}`;
  }
  return closed ? `${d} Z` : d;
}

function styleAttrs(style: Style, type: Shape['type']): string {
  const parts: string[] = [];
  const stroke = style.stroke ?? '#111827';
  parts.push(`stroke="${stroke}"`, `color="${stroke}"`);
  parts.push(`stroke-width="${num(style.strokeWidth ?? 2)}"`);
  parts.push(`stroke-linecap="round"`, `stroke-linejoin="round"`);

  const fillable = type === 'rect' || type === 'ellipse' || type === 'polygon';
  parts.push(`fill="${style.fill && fillable ? style.fill : 'none'}"`);

  if (style.dash && style.dash.length > 0) parts.push(`stroke-dasharray="${style.dash.join(' ')}"`);
  if (style.opacity !== undefined && style.opacity !== 1) parts.push(`opacity="${num(style.opacity)}"`);
  return ` ${parts.join(' ')}`;
}

const num = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0');

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
