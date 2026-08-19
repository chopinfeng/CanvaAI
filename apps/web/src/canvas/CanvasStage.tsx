import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Rect, Stage, Text } from 'react-konva';
import type Konva from 'konva';
import { ORIGIN_LOCAL, boundsOfPoints, hitTestShape, unionBounds, shapeBounds } from '@canvai/canvas-core';
import type { Author, Rect as RectT, Shape, ShapeInput } from '@canvai/protocol';
import type { Connection, Presence } from '../net/connection';
import { toCanvas, useStore, viewportRect } from '../store';
import { IdleQueue } from './idleQueue';
import { ShapeNode } from './ShapeNode';

interface Props {
  conn: Connection;
  me: Author;
}

/**
 * 用户彻底停手多久之后，AI 才介入。
 *
 * "停手"包含鼠标移动：手还在画布上游移说明人还在想，这时候插进来
 * 既打断思路，也容易对着半成品下判断。期间画的内容会攒成一批一起交给 Agent。
 */
const IDLE_BEFORE_AGENT_MS = 5000;

export function CanvasStage({ conn, me }: Props) {
  const stageRef = useRef<Konva.Stage>(null);
  // 尺寸永远不能是 0：Konva 会在 0 宽高的 canvas 上调 drawImage 然后整个应用崩掉。
  // 窗口最小化再恢复、后台标签页被 resize 都会短暂出现 0。
  const [size, setSize] = useState(() => viewportSize());

  const shapes = useStore((s) => s.shapes);
  const camera = useStore((s) => s.camera);
  const tool = useStore((s) => s.tool);
  const strokeColor = useStore((s) => s.strokeColor);
  const strokeWidth = useStore((s) => s.strokeWidth);
  const selection = useStore((s) => s.selection);
  const layerVisible = useStore((s) => s.layerVisible);
  const highlights = useStore((s) => s.highlights);
  const aiPointer = useStore((s) => s.aiPointer);
  const aiStatus = useStore((s) => s.aiStatus);
  const setCamera = useStore((s) => s.setCamera);
  const set = useStore((s) => s.set);

  /** 正在画的临时笔画，不进文档，抬手才落库 */
  const [draft, setDraft] = useState<{ points: Array<[number, number, number]>; start: { x: number; y: number } } | null>(null);
  const drawing = useRef(false);
  const panning = useRef(false);
  const lastPan = useRef({ x: 0, y: 0 });
  const spacePressed = useRef(false);

  const [others, setOthers] = useState<Presence[]>([]);
  const [aiCursor, setAiCursor] = useState<{ x: number; y: number } | null>(null);

  /* ---------------------------------------------------------------- *
   * 停手才叫 Agent
   * ---------------------------------------------------------------- */

  const idleQueue = useRef<IdleQueue<string> | null>(null);

  useEffect(() => {
    const queue = new IdleQueue<string>({
      idleMs: IDLE_BEFORE_AGENT_MS,
      // 页面在后台或没获得焦点时不放行：人没在看，画布不该自己动起来
      canFlush: isForeground,
      onFlush: (ids) => {
        const rects = ids.map((id) => conn.scene.get(id)).filter(Boolean).map((s) => shapeBounds(s!));
        conn.send({
          t: 'user.draw',
          shapeIds: ids,
          region: rects.length > 0 ? unionBounds(rects) : [0, 0, 0, 0],
        });
        set({ awaitingIdle: false });
      },
    });
    idleQueue.current = queue;
    // 用户直接开口时不该再等 5 秒，让对话框能立刻把攒下的笔画一起送出去
    set({ flushDraws: () => queue.flushNow() });

    // 任何输入都算"还在动"。鼠标移动必须算进来，否则会把"正在思考"误判成"已停手"。
    // 监听挂在 window 上：用户在工具栏、对话框上操作同样是活动。
    const markActive = () => queue.markActive();
    const events = ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'touchstart', 'touchmove'] as const;
    for (const e of events) window.addEventListener(e, markActive, { passive: true });

    // 前后台切换：切回来时不立刻放行，重新计时等人坐定；
    // 同时把状态同步给界面——闸门关着却不说，用户会以为 AI 坏了
    const syncForeground = () => {
      const fg = isForeground();
      set({ foreground: fg });
      if (fg) queue.resume();
    };
    syncForeground();
    window.addEventListener('focus', syncForeground);
    window.addEventListener('blur', syncForeground);
    document.addEventListener('visibilitychange', syncForeground);

    return () => {
      for (const e of events) window.removeEventListener(e, markActive);
      window.removeEventListener('focus', syncForeground);
      window.removeEventListener('blur', syncForeground);
      document.removeEventListener('visibilitychange', syncForeground);
      queue.dispose();
      idleQueue.current = null;
      set({ flushDraws: null, awaitingIdle: false });
    };
  }, [conn, set]);

  /* ---------------------------------------------------------------- *
   * 撤销 / 重做
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const m = conn.undoManager;
    const sync = () => set({ undoDepth: m.undoStack.length, redoDepth: m.redoStack.length });

    set({
      undo: () => {
        m.undo();
        sync();
      },
      redo: () => {
        m.redo();
        sync();
      },
    });

    m.on('stack-item-added', sync);
    m.on('stack-item-popped', sync);
    m.on('stack-cleared', sync);
    sync();

    return () => {
      m.off('stack-item-added', sync);
      m.off('stack-item-popped', sync);
      m.off('stack-cleared', sync);
      set({ undo: null, redo: null, undoDepth: 0, redoDepth: 0 });
    };
  }, [conn, set]);

  /* ---------------------------------------------------------------- *
   * 尺寸 / 键盘
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const onResize = () => setSize(viewportSize());
    window.addEventListener('resize', onResize);
    // 有些恢复场景（最小化还原、显示器切换）不触发 resize，补一次测量
    const settle = window.setTimeout(onResize, 0);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space') spacePressed.current = true;
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA';
      if (typing) return;

      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const st = useStore.getState();
        // Cmd+Shift+Z 是 mac 的重做习惯，Ctrl+Y 是 Windows 的
        if (e.shiftKey) st.redo?.();
        else st.undo?.();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useStore.getState().redo?.();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length > 0) {
        e.preventDefault();
        conn.scene.delete(selection, { origin: ORIGIN_LOCAL });
        set({ selection: [] });
      }
      // 按着 Cmd/Ctrl 时不要抢单键快捷键——否则 Cmd+R 会在刷新的同时切成矩形工具
      if (mod) return;
      const map: Record<string, string> = { v: 'select', p: 'pen', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', t: 'text', e: 'eraser' };
      if (map[e.key]) set({ tool: map[e.key] as never });
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spacePressed.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [conn, selection, set]);

  /* ---------------------------------------------------------------- *
   * 在场者（含 AI 光标）
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const update = () => setOthers(conn.others());
    conn.awareness.on('change', update);
    update();
    return () => conn.awareness.off('change', update);
  }, [conn]);

  /**
   * AI 光标平滑移动过去，而不是瞬移；停手一段时间后淡出。
   * 一直挂在那儿会让人以为 AI 还在忙。
   */
  useEffect(() => {
    if (!aiPointer) return;
    const from = aiCursor ?? aiPointer;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / Math.max(1, aiPointer.ms));
      const ease = 1 - (1 - p) ** 3;
      setAiCursor({ x: from.x + (aiPointer.x - from.x) * ease, y: from.y + (aiPointer.y - from.y) * ease });
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    const hide = window.setTimeout(() => setAiCursor(null), aiPointer.ms + 6000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(hide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiPointer]);

  /* ---------------------------------------------------------------- *
   * 视口上报 —— Agent 靠它知道用户在看哪
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const t = window.setTimeout(() => {
      conn.send({ t: 'user.viewport', rect: viewportRect(camera, size.w, size.h), zoom: camera.zoom });
    }, 200);
    return () => window.clearTimeout(t);
  }, [camera, size, conn]);

  useEffect(() => {
    conn.send({ t: 'user.select', shapeIds: selection });
    conn.setSelection(selection);
  }, [selection, conn]);

  /* ---------------------------------------------------------------- *
   * 指针
   * ---------------------------------------------------------------- */

  const pointer = useCallback((): { x: number; y: number } => {
    const stage = stageRef.current;
    const p = stage?.getPointerPosition();
    return p ? toCanvas(p, camera) : { x: 0, y: 0 };
  }, [camera]);

  const notifyDraw = useCallback((ids: string[]) => {
    idleQueue.current?.push(...ids);
    set({ awaitingIdle: true });
  }, [set]);

  const onPointerDown = useCallback(
    (e: Konva.KonvaEventObject<PointerEvent>) => {
      const isPan = spacePressed.current || e.evt.button === 1 || (tool === 'select' && e.target === e.target.getStage());
      const p = pointer();

      if (spacePressed.current || e.evt.button === 1) {
        panning.current = true;
        lastPan.current = { x: e.evt.clientX, y: e.evt.clientY };
        return;
      }

      if (tool === 'select') {
        if (isPan) set({ selection: [] });
        return;
      }

      if (tool === 'eraser') {
        const hit = [...shapes].reverse().find((s) => hitTestShape(s, p, 6 / camera.zoom));
        if (hit) conn.scene.delete([hit.id], { origin: ORIGIN_LOCAL });
        return;
      }

      if (tool === 'text') {
        const text = window.prompt('输入文字');
        if (text) {
          const { ids } = conn.scene.create(
            [{ type: 'text', x: p.x, y: p.y, text, style: { stroke: strokeColor, fontSize: 18 } }],
            { author: me, origin: ORIGIN_LOCAL },
          );
          notifyDraw(ids);
        }
        return;
      }

      drawing.current = true;
      setDraft({ points: [[p.x, p.y, 0.5]], start: p });
    },
    [tool, pointer, shapes, camera.zoom, conn, strokeColor, me, notifyDraw, set],
  );

  const onPointerMove = useCallback(
    (e: Konva.KonvaEventObject<PointerEvent>) => {
      if (panning.current) {
        const dx = e.evt.clientX - lastPan.current.x;
        const dy = e.evt.clientY - lastPan.current.y;
        lastPan.current = { x: e.evt.clientX, y: e.evt.clientY };
        setCamera({ x: camera.x + dx, y: camera.y + dy });
        return;
      }

      const p = pointer();
      conn.setCursor(p.x, p.y);
      if (!drawing.current || !draft) return;

      const pressure = (e.evt as PointerEvent).pressure || 0.5;
      setDraft((d) => (d ? { ...d, points: [...d.points, [p.x, p.y, pressure]] } : d));
    },
    [camera, draft, pointer, setCamera, conn],
  );

  const onPointerUp = useCallback(() => {
    panning.current = false;
    if (!drawing.current || !draft) {
      drawing.current = false;
      return;
    }
    drawing.current = false;

    const pts = draft.points;
    const last = pts[pts.length - 1]!;
    const style = { stroke: strokeColor, strokeWidth };
    let input: ShapeInput | null = null;

    switch (tool) {
      case 'pen': {
        if (pts.length < 2) break;
        const ox = pts[0]![0];
        const oy = pts[0]![1];
        input = {
          type: 'freedraw',
          x: ox,
          y: oy,
          points: pts.map((p) => [round(p[0] - ox), round(p[1] - oy), round(p[2], 2)] as [number, number, number]),
          style,
        };
        break;
      }
      case 'rect':
      case 'ellipse': {
        const x = Math.min(draft.start.x, last[0]);
        const y = Math.min(draft.start.y, last[1]);
        const w = Math.abs(last[0] - draft.start.x);
        const h = Math.abs(last[1] - draft.start.y);
        if (w < 3 || h < 3) break;
        input = { type: tool, x: round(x), y: round(y), w: round(w), h: round(h), style };
        break;
      }
      case 'line':
      case 'arrow': {
        if (Math.hypot(last[0] - draft.start.x, last[1] - draft.start.y) < 3) break;
        input = {
          type: tool,
          x: round(draft.start.x),
          y: round(draft.start.y),
          points: [[0, 0], [round(last[0] - draft.start.x), round(last[1] - draft.start.y)]],
          style: { ...style, arrowEnd: tool === 'arrow' },
        };
        break;
      }
      default:
        break;
    }

    setDraft(null);
    if (!input) return;

    const { ids } = conn.scene.create([input], { author: me, origin: ORIGIN_LOCAL });
    notifyDraw(ids);
  }, [draft, tool, strokeColor, strokeWidth, conn, me, notifyDraw]);

  const onWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = stageRef.current;
      const p = stage?.getPointerPosition();
      if (!p) return;

      // 触控板双指是平移，ctrl/cmd + 滚轮是缩放（和主流画布工具一致）
      if (!e.evt.ctrlKey && !e.evt.metaKey) {
        setCamera({ x: camera.x - e.evt.deltaX, y: camera.y - e.evt.deltaY });
        return;
      }

      const scaleBy = 1 - e.evt.deltaY * 0.002;
      const zoom = Math.max(0.05, Math.min(8, camera.zoom * scaleBy));
      const worldBefore = toCanvas(p, camera);
      setCamera({ zoom, x: p.x - worldBefore.x * zoom, y: p.y - worldBefore.y * zoom });
    },
    [camera, setCamera],
  );

  /* ---------------------------------------------------------------- *
   * 渲染
   * ---------------------------------------------------------------- */

  const visible = useMemo(
    () => shapes.filter((s) => layerVisible[s.layer] !== false),
    [shapes, layerVisible],
  );

  /**
   * 只有提案层半透明。
   *
   * 早先这里还有一条"聚光"：把没被点名的图元整体压暗。实测讲题时更糟——
   * 学生要同时看清标出来的那条边和它周围的图，周围一暗参照物就没了，
   * 等于把整张图变模糊。现在改成只让高亮的那几个动起来（见 pulse.ts）。
   */
  const dimOf = useCallback((s: Shape): number => (s.layer === 'suggest' ? 0.5 : 1), []);

  const selectShape = useCallback(
    (id: string, additive: boolean) => {
      const cur = useStore.getState().selection;
      set({ selection: additive ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id] });
    },
    [set],
  );

  const moveShape = useCallback(
    (id: string, x: number, y: number) => {
      conn.scene.update([{ id, set: { x: round(x), y: round(y) } }], { origin: ORIGIN_LOCAL });
    },
    [conn],
  );

  const selBounds: RectT | null = useMemo(() => {
    const sel = visible.filter((s) => selection.includes(s.id));
    return sel.length > 0 ? unionBounds(sel.map(shapeBounds)) : null;
  }, [visible, selection]);

  return (
    <Stage
      ref={stageRef}
      width={size.w}
      height={size.h}
      x={camera.x}
      y={camera.y}
      scaleX={camera.zoom}
      scaleY={camera.zoom}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onWheel={onWheel}
      style={{ cursor: cursorFor(tool), background: '#fafaf9' }}
    >
      <Layer listening={false}>
        <GridDots camera={camera} size={size} />
      </Layer>

      <Layer>
        {visible.map((s) => (
          <ShapeNode
            key={s.id}
            shape={s}
            opacity={dimOf(s)}
            highlight={highlights[s.id]}
            selected={selection.includes(s.id)}
            onSelect={tool === 'select' ? selectShape : undefined}
            draggable={tool === 'select' && selection.includes(s.id)}
            onDragEnd={moveShape}
          />
        ))}

        {/* 正在画的临时笔画 */}
        {draft && <DraftPreview draft={draft} tool={tool} color={strokeColor} width={strokeWidth} />}
      </Layer>

      <Layer listening={false}>
        {selBounds && (
          <Rect
            x={selBounds[0] - 4}
            y={selBounds[1] - 4}
            width={selBounds[2] + 8}
            height={selBounds[3] + 8}
            stroke="#2563eb"
            strokeWidth={1 / camera.zoom}
            dash={[4 / camera.zoom, 4 / camera.zoom]}
          />
        )}

        {others.map((p, i) =>
          p.cursor ? (
            <Cursor key={i} x={p.cursor.x} y={p.cursor.y} color={p.user.color} name={p.user.name} zoom={camera.zoom} />
          ) : null,
        )}

        {aiCursor && (
          <Cursor x={aiCursor.x} y={aiCursor.y} color="#7c3aed" name={aiStatus || 'AI'} zoom={camera.zoom} ai />
        )}
      </Layer>
    </Stage>
  );
}

/* ------------------------------------------------------------------ */

function DraftPreview({
  draft,
  tool,
  color,
  width,
}: {
  draft: { points: Array<[number, number, number]>; start: { x: number; y: number } };
  tool: string;
  color: string;
  width: number;
}) {
  const pts = draft.points;
  const last = pts[pts.length - 1]!;

  if (tool === 'pen') {
    const b = boundsOfPoints(pts.map((p) => ({ x: p[0], y: p[1] })));
    return (
      <ShapeNode
        opacity={0.9}
        shape={
          {
            id: '__draft',
            type: 'freedraw',
            layer: 'user',
            author: { id: 'me', kind: 'user' },
            opId: '__draft',
            x: 0,
            y: 0,
            rotation: 0,
            z: 1e9,
            points: pts,
            style: { stroke: color, strokeWidth: width },
            meta: {},
            createdAt: 0,
            updatedAt: 0,
          } as unknown as Shape
        }
      />
    );
    void b;
  }

  const x = Math.min(draft.start.x, last[0]);
  const y = Math.min(draft.start.y, last[1]);
  const w = Math.abs(last[0] - draft.start.x);
  const h = Math.abs(last[1] - draft.start.y);

  const base = {
    id: '__draft',
    layer: 'user' as const,
    author: { id: 'me', kind: 'user' as const },
    opId: '__draft',
    rotation: 0,
    z: 1e9,
    style: { stroke: color, strokeWidth: width, arrowEnd: tool === 'arrow' },
    meta: {},
    createdAt: 0,
    updatedAt: 0,
  };

  const shape =
    tool === 'rect' || tool === 'ellipse'
      ? { ...base, type: tool, x, y, w, h }
      : {
          ...base,
          type: tool,
          x: draft.start.x,
          y: draft.start.y,
          points: [[0, 0], [last[0] - draft.start.x, last[1] - draft.start.y]],
        };

  return <ShapeNode shape={shape as unknown as Shape} opacity={0.7} />;
}

function Cursor({
  x,
  y,
  color,
  name,
  zoom,
  ai,
}: {
  x: number;
  y: number;
  color: string;
  name: string;
  zoom: number;
  ai?: boolean;
}) {
  const k = 1 / zoom;
  return (
    <Group x={x} y={y} listening={false}>
      <Circle radius={5 * k} fill={color} opacity={0.9} />
      {ai && <Circle radius={11 * k} stroke={color} strokeWidth={1.5 * k} opacity={0.5} />}
      <Rect
        x={8 * k}
        y={-9 * k}
        width={(labelWidth(name) + 12) * k}
        height={18 * k}
        fill={color}
        cornerRadius={4 * k}
        opacity={0.92}
      />
      <Text
        x={13 * k}
        y={-5 * k}
        text={name}
        fontSize={11 * k}
        fill="#fff"
        fontFamily='system-ui, -apple-system, "PingFang SC", sans-serif'
      />
    </Group>
  );
}

/** 无限画布的点阵背景，随缩放自适应密度 */
function GridDots({ camera, size }: { camera: { x: number; y: number; zoom: number }; size: { w: number; h: number } }) {
  const step = camera.zoom > 1.6 ? 20 : camera.zoom > 0.6 ? 40 : camera.zoom > 0.25 ? 100 : 200;
  const [vx, vy, vw, vh] = viewportRect(camera, size.w, size.h);
  const x0 = Math.floor(vx / step) * step;
  const y0 = Math.floor(vy / step) * step;
  const dots = [];
  const r = Math.max(0.5, 1 / camera.zoom);

  for (let x = x0; x < vx + vw + step; x += step) {
    for (let y = y0; y < vy + vh + step; y += step) {
      dots.push(<Circle key={`${x},${y}`} x={x} y={y} radius={r} fill="#d6d3d1" />);
      if (dots.length > 4000) return <>{dots}</>;
    }
  }
  return <>{dots}</>;
}

/**
 * 页面是不是真的在人眼前。
 *
 * 两个条件都要：标签页可见（没被切走、窗口没最小化），
 * 且窗口有焦点（没被别的应用盖在上面）。
 * 只看 visibilityState 拦不住"浏览器还开着但用户在别的程序里"。
 */
function isForeground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** 视口尺寸，下限 1px —— 0 会让 Konva 在 drawImage 上抛异常并白屏 */
function viewportSize(): { w: number; h: number } {
  return {
    w: Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1),
    h: Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1),
  };
}

/** 粗估标签宽度：中文按 1em，其余按 0.6em。够画个气泡底就行。 */
function labelWidth(name: string): number {
  let units = 0;
  for (const ch of name) units += ch.charCodeAt(0) > 0x2e80 ? 1 : 0.6;
  return units * 11;
}

const round = (n: number, d = 1): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

const cursorFor = (tool: string): string => {
  switch (tool) {
    case 'select': return 'default';
    case 'eraser': return 'cell';
    case 'text': return 'text';
    default: return 'crosshair';
  }
};
