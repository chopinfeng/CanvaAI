import { useEffect, useRef, useState } from 'react';
import { Arrow, Ellipse, Line, Rect, Text } from 'react-konva';
import { getStroke } from 'perfect-freehand';
import type { Shape } from '@canvai/protocol';

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
  const s = shape.style;

  const stroke = highlight ? '#f59e0b' : s.stroke ?? '#111827';
  const strokeWidth = (s.strokeWidth ?? 2) * (highlight ? 1.8 : 1) * (selected ? 1.2 : 1);
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
    ...(highlight === 'glow' ? { shadowColor: '#f59e0b', shadowBlur: 20, shadowOpacity: 0.9 } : {}),
  };

  switch (shape.type) {
    case 'rect':
    case 'image':
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
    case 'latex':
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

    default:
      return null;
  }
}
