import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import type {
  Author,
  LayerId,
  Rect,
  SceneDiff,
  Shape,
  ShapeBrief,
  ShapeInput,
} from '@canvai/protocol';
import { LAYER_ORDER, ShapeSchema } from '@canvai/protocol';
import { rectsIntersect, shapeBounds } from './geometry.js';

export const newShapeId = (): string => `sh_${nanoid(10)}`;
export const newOpId = (): string => `op_${nanoid(8)}`;

/** 改动来源标记，用来区分本地/远端/AI，渲染层据此决定要不要播落笔动画 */
export const ORIGIN_LOCAL = 'local';
export const ORIGIN_AI = 'ai';
export const ORIGIN_REMOTE = 'remote';

const SHAPES_KEY = 'shapes';
const LAYERS_KEY = 'layers';

export interface LayerState {
  visible: boolean;
  opacity: number;
}

const DEFAULT_LAYER_STATE: Record<LayerId, LayerState> = {
  user: { visible: true, opacity: 1 },
  ai: { visible: true, opacity: 1 },
  annot: { visible: true, opacity: 1 },
  suggest: { visible: true, opacity: 0.45 },
};

/**
 * 一个 Scene 就是一张画布。
 *
 * 存储用嵌套 Y.Map（shapeId → Y.Map<字段>），这样用户拖动某个图形的同时
 * AI 改它的颜色不会互相覆盖——冲突解决落在字段粒度，而不是整个图元。
 */
export class Scene {
  readonly doc: Y.Doc;

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    // 触发根类型创建
    this.shapesMap;
    this.layersMap;
  }

  private get shapesMap(): Y.Map<Y.Map<unknown>> {
    return this.doc.getMap<Y.Map<unknown>>(SHAPES_KEY);
  }

  private get layersMap(): Y.Map<LayerState> {
    return this.doc.getMap<LayerState>(LAYERS_KEY);
  }

  /* ---------------------------------------------------------------- *
   * 读
   * ---------------------------------------------------------------- */

  get(id: string): Shape | undefined {
    const m = this.shapesMap.get(id);
    if (!m) return undefined;
    return yMapToShape(m);
  }

  has(id: string): boolean {
    return this.shapesMap.has(id);
  }

  get size(): number {
    return this.shapesMap.size;
  }

  /** 按 z 升序返回全部图元 */
  all(): Shape[] {
    const out: Shape[] = [];
    this.shapesMap.forEach((m) => out.push(yMapToShape(m)));
    return sortForRender(out);
  }

  byLayer(layer: LayerId): Shape[] {
    return this.all().filter((s) => s.layer === layer);
  }

  layerState(id: LayerId): LayerState {
    return this.layersMap.get(id) ?? DEFAULT_LAYER_STATE[id];
  }

  setLayerState(id: LayerId, patch: Partial<LayerState>, origin: unknown = ORIGIN_LOCAL): void {
    this.doc.transact(() => {
      this.layersMap.set(id, { ...this.layerState(id), ...patch });
    }, origin);
  }

  /** 与区域相交的图元 */
  inRegion(region: Rect): Shape[] {
    return this.all().filter((s) => rectsIntersect(shapeBounds(s), region));
  }

  brief(s: Shape): ShapeBrief {
    const b: ShapeBrief = { id: s.id, type: s.type, layer: s.layer, bbox: roundRect(shapeBounds(s)) };
    if (s.meta.role) b.role = s.meta.role;
    if (s.meta.label) b.label = s.meta.label;
    if (s.text) b.text = s.text.length > 40 ? `${s.text.slice(0, 40)}…` : s.text;
    return b;
  }

  /** 全部内容的包围盒 */
  contentBounds(): Rect {
    const shapes = this.all();
    if (shapes.length === 0) return [0, 0, 0, 0];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of shapes) {
      const [x, y, w, h] = shapeBounds(s);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }
    return [minX, minY, maxX - minX, maxY - minY];
  }

  /* ---------------------------------------------------------------- *
   * 写
   *
   * 所有写入都在一个 Y 事务里完成，并共享一个 opId ——
   * 于是"AI 画了一座房子"在用户按下 Cmd+Z 时是一步撤销，而不是十几步。
   * ---------------------------------------------------------------- */

  create(
    inputs: ShapeInput[],
    ctx: { author: Author; layer?: LayerId; opId?: string; origin?: unknown },
  ): { ids: string[]; diff: SceneDiff } {
    const opId = ctx.opId ?? newOpId();
    const now = Date.now();
    const ids: string[] = [];

    this.doc.transact(() => {
      for (const input of inputs) {
        const layer = input.layer ?? ctx.layer ?? (ctx.author.kind === 'ai' ? 'ai' : 'user');
        const id = input.id ?? newShapeId();
        const shape: Shape = ShapeSchema.parse({
          x: 0,
          y: 0,
          rotation: 0,
          style: {},
          meta: {},
          ...input,
          id,
          layer,
          author: ctx.author,
          opId,
          z: this.nextZ(layer),
          createdAt: now,
          updatedAt: now,
        });
        this.shapesMap.set(id, shapeToYMap(shape));
        ids.push(id);
      }
    }, ctx.origin ?? (ctx.author.kind === 'ai' ? ORIGIN_AI : ORIGIN_LOCAL));

    return { ids, diff: { opId, created: ids, updated: [], deleted: [] } };
  }

  update(
    patches: Array<{ id: string; set: Partial<Shape> }>,
    ctx: { opId?: string; origin?: unknown } = {},
  ): SceneDiff {
    const opId = ctx.opId ?? newOpId();
    const updated: string[] = [];
    const now = Date.now();

    this.doc.transact(() => {
      for (const { id, set } of patches) {
        const m = this.shapesMap.get(id);
        if (!m) continue;
        for (const [k, v] of Object.entries(set)) {
          if (k === 'id' || k === 'createdAt') continue;
          if (v === undefined) continue;
          // style / meta 做浅合并，避免"改个颜色把字号冲掉"
          if ((k === 'style' || k === 'meta') && isPlainObject(v)) {
            const prev = (m.get(k) as Record<string, unknown>) ?? {};
            m.set(k, { ...prev, ...(v as Record<string, unknown>) });
          } else {
            m.set(k, v as unknown);
          }
        }
        m.set('updatedAt', now);
        updated.push(id);
      }
    }, ctx.origin ?? ORIGIN_LOCAL);

    return { opId, created: [], updated, deleted: [] };
  }

  delete(ids: string[], ctx: { opId?: string; origin?: unknown } = {}): SceneDiff {
    const opId = ctx.opId ?? newOpId();
    const deleted: string[] = [];
    this.doc.transact(() => {
      for (const id of ids) {
        if (this.shapesMap.has(id)) {
          this.shapesMap.delete(id);
          deleted.push(id);
        }
      }
    }, ctx.origin ?? ORIGIN_LOCAL);
    return { opId, created: [], updated: [], deleted };
  }

  /** 把某次 op 产生的图元整体搬到另一个图层——suggest → ai 的 Accept 走这里 */
  promoteOp(opId: string, toLayer: LayerId, origin: unknown = ORIGIN_LOCAL): SceneDiff {
    const ids = this.all().filter((s) => s.opId === opId).map((s) => s.id);
    this.doc.transact(() => {
      for (const id of ids) {
        const m = this.shapesMap.get(id);
        if (!m) continue;
        m.set('layer', toLayer);
        m.set('z', this.nextZ(toLayer));
        m.set('updatedAt', Date.now());
      }
    }, origin);
    return { opId, created: [], updated: ids, deleted: [] };
  }

  deleteOp(opId: string, origin: unknown = ORIGIN_LOCAL): SceneDiff {
    const ids = this.all().filter((s) => s.opId === opId).map((s) => s.id);
    return this.delete(ids, { opId, origin });
  }

  clearLayer(layer: LayerId, origin: unknown = ORIGIN_LOCAL): SceneDiff {
    return this.delete(this.byLayer(layer).map((s) => s.id), { origin });
  }

  /* ---------------------------------------------------------------- *
   * z 序：分数索引，插入不需要重排已有图元
   * ---------------------------------------------------------------- */

  private nextZ(layer: LayerId): number {
    let max = 0;
    this.shapesMap.forEach((m) => {
      if (m.get('layer') === layer) {
        const z = (m.get('z') as number) ?? 0;
        if (z > max) max = z;
      }
    });
    return max + 1;
  }

  /* ---------------------------------------------------------------- *
   * 序列化
   * ---------------------------------------------------------------- */

  toJSON(): { shapes: Shape[]; layers: Record<string, LayerState> } {
    const layers: Record<string, LayerState> = {};
    for (const id of LAYER_ORDER) layers[id] = this.layerState(id);
    return { shapes: this.all(), layers };
  }

  /** 用于测试与快照：从纯 JSON 重建 */
  static fromShapes(shapes: Shape[]): Scene {
    const scene = new Scene();
    scene.doc.transact(() => {
      for (const s of shapes) scene.shapesMap.set(s.id, shapeToYMap(s));
    });
    return scene;
  }

  onChange(fn: (diff: { changed: Set<string>; origin: unknown }) => void): () => void {
    const handler = (events: Y.YEvent<any>[], tr: Y.Transaction) => {
      const changed = new Set<string>();
      for (const e of events) {
        if (e.target === this.shapesMap) {
          e.changes.keys.forEach((_v, k) => changed.add(k));
        } else {
          const key = e.path[0];
          if (typeof key === 'string') changed.add(key);
        }
      }
      if (changed.size > 0) fn({ changed, origin: tr.origin });
    };
    this.shapesMap.observeDeep(handler);
    return () => this.shapesMap.unobserveDeep(handler);
  }
}

/* ------------------------------------------------------------------ *
 * 渲染顺序：先按图层，再按 z
 * ------------------------------------------------------------------ */

export function sortForRender(shapes: Shape[]): Shape[] {
  const rank = new Map<LayerId, number>(LAYER_ORDER.map((l, i) => [l, i]));
  return [...shapes].sort((a, b) => {
    const la = rank.get(a.layer) ?? 0;
    const lb = rank.get(b.layer) ?? 0;
    return la !== lb ? la - lb : a.z - b.z;
  });
}

/* ------------------------------------------------------------------ *
 * Y.Map ⇄ Shape
 * ------------------------------------------------------------------ */

function shapeToYMap(shape: Shape): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(shape)) {
    if (v !== undefined) m.set(k, v);
  }
  return m;
}

function yMapToShape(m: Y.Map<unknown>): Shape {
  const raw: Record<string, unknown> = {};
  m.forEach((v, k) => {
    raw[k] = v;
  });
  return raw as unknown as Shape;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const roundRect = ([x, y, w, h]: Rect): Rect => [
  Math.round(x),
  Math.round(y),
  Math.round(w),
  Math.round(h),
];
