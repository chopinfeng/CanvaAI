import { useEffect, useRef, useState } from 'react';
import { Arrow, Ellipse, Image as KonvaImage, Line, Rect, Text } from 'react-konva';
import { getStroke } from 'perfect-freehand';
import type { Shape } from '@canvai/protocol';
import { usePulse } from './pulse.js';
import { api } from '../net/base.js';

interface Props {
  shape: Shape;
  opacity: number;
  highlight?: 'glow' | 'outline' | 'pulse';
  onSelect?: (id: string, additive: boolean) => void;
  selected?: boolean;
  draggable?: boolean;
  onDragEnd?: (id: string, x: number, y: number) => void;
}

/**
 * 落笔动画。
 *
 * AI 的图形不该"啪"地出现——那看起来像贴图，不像有人在画。
 * 点序列图元按弧长逐段显现，其余图元用淡入+微缩放。
 * 动画只影响渲染，文档里存的始终是终态。
 */
function useDrawIn(shape: Shape): number {
  const [progress, setProgress] = useState(() => (shape.anim?.kind === 'draw' ? 0 : 1));
  const started = useRef(false);

  useEffect(() => {
    if (shape.anim?.kind !== 'draw' || started.current) return;
    started.current = true;

    const ms = shape.anim.ms || 600;
    const delay = shape.anim.delay || 0;
    let raf = 0;
    let t0 = 0;

    const tick = (t: number) => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / ms);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };

    const timer = window.setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, delay);

    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [shape.anim?.kind, shape.anim?.ms, shape.anim?.delay]);

  return progress;
}

/**
 * 图片资源加载。
 *
 * 同一张原图往往会被多道题引用，缓存住避免重复解码；
 * 加载中/失败时给个占位框，不能让画布上凭空少一块又没有任何提示。
 */
const imageCache = new Map<string, HTMLImageElement>();

function useAssetImage(assetId: string | undefined): {
  image: HTMLImageElement | null;
  failed: boolean;
} {
  const [image, setImage] = useState<HTMLImageElement | null>(() =>
    assetId ? imageCache.get(assetId) ?? null : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!assetId) return;
    const cached = imageCache.get(assetId);
    if (cached) {
      setImage(cached);
      return;
    }

    let alive = true;
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!alive) return;
      imageCache.set(assetId, img);
      setImage(img);
    };
    img.onerror = () => {
      if (alive) setFailed(true);
    };
    img.src = api(`assets/${encodeURIComponent(assetId)}`);

    return () => {
      alive = false;
    };
  }, [assetId]);

  return { image, failed };
}

/**
 * LaTeX -> 图片。
 *
 * MathJax 是个不小的依赖（排版逻辑 + 内嵌字形数据），大部分画布可能一个公式
 * 都没有，不该让每个人打开画布都先付这份体积——用动态 import 懒加载，
 * 真的出现 latex 图元才去拉这块代码，canvas-core 也为此单独开了 `./latex`
 * 子路径导出，避免拖上其余模块。
 *
 * 排版本身也有实打实的 CPU 开销，`useDrawIn` 的动画每帧都会让 ShapeNode
 * 重渲染，不能每帧都重跑一遍——用 (text, fontSize, color) 做 key 缓存，
 * 都没变就直接复用。渲染结果是自洽的 SVG 字符串，转成 data URI 直接喂给
 * Image，不用额外发请求。
 */
const latexCache = new Map<string, { image: HTMLImageElement; width: number; height: number }>();

function useLatexImage(
  text: string,
  fontSize: number,
  color: string,
): { image: HTMLImageElement | null; width: number; height: number } {
  const key = text ? `${fontSize}::${color}::${text}` : '';
  const cached = key ? latexCache.get(key) : undefined;
  const [state, setState] = useState(() => cached ?? { image: null, width: 0, height: 0 });

  useEffect(() => {
    if (!key) {
      setState({ image: null, width: 0, height: 0 });
      return;
    }
    const hit = latexCache.get(key);
    if (hit) {
      setState(hit);
      return;
    }

    let alive = true;
    import('@canvai/canvas-core/latex').then(({ renderLatexToSvg, isLatexError }) => {
      if (!alive) return;
      const rendered = renderLatexToSvg(text, fontSize, color);
      if (isLatexError(rendered)) {
        setState({ image: null, width: 0, height: 0 });
        return;
      }

      const img = new window.Image();
      img.onload = () => {
        if (!alive) return;
        const entry = { image: img, width: rendered.width, height: rendered.height };
        latexCache.set(key, entry);
        setState(entry);
      };
      img.onerror = () => {
        if (alive) setState({ image: null, width: 0, height: 0 });
      };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(rendered.svg)}`;
    });

    return () => {
      alive = false;
    };
  }, [key, text, fontSize, color]);

  return state;
}

/** 按进度截取点序列，最后一段做插值，避免一跳一跳 */
function partialPoints(points: Array<number[]>, progress: number): number[] {
  const flat: number[] = [];
  if (points.length === 0) return flat;
  if (progress >= 1) {
    for (const p of points) flat.push(p[0] ?? 0, p[1] ?? 0);
    return flat;
  }

  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0));
    lens.push(d);
    total += d;
  }

  const target = total * progress;
  let acc = 0;
  flat.push(points[0]![0] ?? 0, points[0]![1] ?? 0);

  for (let i = 1; i < points.length; i++) {
    const seg = lens[i - 1] ?? 0;
    if (acc + seg <= target) {
      flat.push(points[i]![0] ?? 0, points[i]![1] ?? 0);
      acc += seg;
    } else {
      const t = seg === 0 ? 0 : (target - acc) / seg;
      const a = points[i - 1]!;
      const b = points[i]!;
      flat.push((a[0] ?? 0) + ((b[0] ?? 0) - (a[0] ?? 0)) * t, (a[1] ?? 0) + ((b[1] ?? 0) - (a[1] ?? 0)) * t);
      break;
    }
  }
  return flat;
}

export function ShapeNode({ shape, opacity, highlight, onSelect, selected, draggable, onDragEnd }: Props) {
  const progress = useDrawIn(shape);
  const asset = useAssetImage(shape.type === 'image' ? shape.assetId : undefined);
  const s = shape.style;
  const latex = useLatexImage(shape.type === 'latex' ? shape.text ?? '' : '', s.fontSize ?? 16, s.stroke ?? '#111827');

  /**
   * 高亮靠"动"来抓注意力，不靠把别处压暗。
   *
   * 早先是给非高亮部分整体降透明度（聚光），实测反而更糟：
   * 讲题时学生需要同时看清标出来的那条边**和**它周围的图，
   * 压暗了周围，参照物就没了，等于把整张图变模糊。
   * 现在别处一点不动，只让高亮的这几个呼吸。
   */
  const pulse = usePulse(!!highlight);

  const stroke = highlight ? '#f59e0b' : s.stroke ?? '#111827';
  /**
   * 高亮描边要比原线粗一大截才压得住——录像里反馈过：原来的 1.7~2.2 倍
   * 放在细线（辅助线常常就 1~2px）上，加粗后也才 3~4px，跟满屏的线混在
   * 一起还是不跳眼。改成固定下限（至少 4px）加更大的倍数。
   */
  const strokeWidth = highlight
    ? Math.max((s.strokeWidth ?? 2) * (2.4 + pulse * 0.8), 4) * (selected ? 1.2 : 1)
    : (s.strokeWidth ?? 2) * (selected ? 1.2 : 1);
  const baseOpacity = (s.opacity ?? 1) * opacity;

  const common = {
    opacity: shape.anim?.kind === 'fade' ? baseOpacity * progress : baseOpacity,
    stroke,
    strokeWidth,
    ...(s.dash && s.dash.length > 0 ? { dash: s.dash } : {}),
    rotation: shape.rotation || 0,
    listening: true,
    onMouseDown: (e: { evt: MouseEvent; cancelBubble: boolean }) => {
      if (!onSelect) return;
      e.cancelBubble = true;
      onSelect(shape.id, e.evt.shiftKey);
    },
    draggable: draggable ?? false,
    onDragEnd: (e: { target: { x(): number; y(): number } }) => onDragEnd?.(shape.id, e.target.x(), e.target.y()),
    ...(selected ? { shadowColor: '#2563eb', shadowBlur: 8, shadowOpacity: 0.6 } : {}),
    // glow 和 pulse 都做成呼吸，差别只在幅度：pulse 更急一点，用于"就看这儿"
    ...(highlight === 'glow' || highlight === 'pulse'
      ? {
          shadowColor: '#f59e0b',
          shadowBlur: (highlight === 'pulse' ? 18 : 24) + pulse * (highlight === 'pulse' ? 26 : 20),
          shadowOpacity: 0.75 + pulse * 0.25,
        }
      : {}),
  };

  switch (shape.type) {
    case 'rect':
      return (
        <Rect
          {...common}
          x={shape.x}
          y={shape.y}
          width={(shape.w ?? 0) * (shape.anim?.kind === 'draw' ? progress : 1)}
          height={(shape.h ?? 0) * (shape.anim?.kind === 'draw' ? progress : 1)}
          fill={s.fill}
          cornerRadius={2}
        />
      );

    case 'image': {
      const w = shape.w ?? 0;
      const h = shape.h ?? 0;
      if (asset.image) {
        return (
          <KonvaImage {...common} x={shape.x} y={shape.y} width={w} height={h} image={asset.image} stroke={undefined} strokeWidth={0} />
        );
      }
      // 没加载出来时留个占位框——画布上凭空缺一块却不给提示最难排查
      return (
        <Rect
          {...common}
          x={shape.x}
          y={shape.y}
          width={w}
          height={h}
          fill={asset.failed ? '#fef2f2' : '#f5f5f4'}
          stroke={asset.failed ? '#fca5a5' : '#d6d3d1'}
          strokeWidth={1}
          dash={[6, 4]}
          cornerRadius={2}
        />
      );
    }

    case 'ellipse':
      return (
        <Ellipse
          {...common}
          x={shape.x + (shape.w ?? 0) / 2}
          y={shape.y + (shape.h ?? 0) / 2}
          radiusX={((shape.w ?? 0) / 2) * (shape.anim?.kind === 'draw' ? progress : 1)}
          radiusY={((shape.h ?? 0) / 2) * (shape.anim?.kind === 'draw' ? progress : 1)}
          fill={s.fill}
        />
      );

    case 'arrow': {
      const pts = partialPoints(shape.points ?? [], progress);
      if (pts.length < 4) return null;
      return (
        <Arrow
          {...common}
          x={shape.x}
          y={shape.y}
          points={pts}
          fill={stroke}
          pointerLength={10}
          pointerWidth={8}
        />
      );
    }

    case 'line':
    case 'polygon':
    case 'path':
    case 'plot':
    case 'construct': {
      const pts = partialPoints(shape.points ?? [], progress);
      if (pts.length < 4) return null;
      return (
        <Line
          {...common}
          x={shape.x}
          y={shape.y}
          points={pts}
          closed={progress >= 1 && (shape.closed ?? shape.type === 'polygon')}
          fill={s.fill}
          lineCap="round"
          lineJoin="round"
          tension={shape.type === 'plot' ? 0.3 : 0}
        />
      );
    }

    case 'freedraw': {
      const raw = (shape.points ?? []).map((p) => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0.5] as [number, number, number]);
      const visible = progress >= 1 ? raw : raw.slice(0, Math.max(2, Math.floor(raw.length * progress)));
      if (visible.length < 2) return null;
      const outline = getStroke(visible, {
        size: (s.strokeWidth ?? 3) * 2,
        thinning: 0.5,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: visible[0]![2] === 0.5,
      });
      return (
        <Line
          {...common}
          x={shape.x}
          y={shape.y}
          points={outline.flatMap(([px, py]) => [px ?? 0, py ?? 0])}
          closed
          fill={stroke}
          stroke={undefined}
          strokeWidth={0}
          tension={0.1}
        />
      );
    }

    case 'text':
      return (
        <Text
          {...common}
          x={shape.x}
          y={shape.y}
          text={shape.text ?? ''}
          fontSize={s.fontSize ?? 16}
          fontFamily={s.fontFamily ?? 'system-ui, -apple-system, "PingFang SC", sans-serif'}
          fill={stroke}
          stroke={undefined}
          strokeWidth={0}
        />
      );

    case 'latex':
      // 排版失败（或还没排完）就退化成纯文本——跟服务端 SVG 渲染器行为一致，
      // 不能让图元凭空消失
      if (!latex.image) {
        return (
          <Text
            {...common}
            x={shape.x}
            y={shape.y}
            text={shape.text ?? ''}
            fontSize={s.fontSize ?? 16}
            fontFamily={s.fontFamily ?? 'system-ui, -apple-system, "PingFang SC", sans-serif'}
            fill={stroke}
            stroke={undefined}
            strokeWidth={0}
          />
        );
      }
      return (
        <KonvaImage
          {...common}
          x={shape.x}
          y={shape.y}
          width={latex.width}
          height={latex.height}
          image={latex.image}
          stroke={undefined}
          strokeWidth={0}
        />
      );

    default:
      return null;
  }
}
