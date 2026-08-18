import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Author } from '@canvai/protocol';
import { ORIGIN_AI, ORIGIN_LOCAL, ORIGIN_REMOTE, Scene, createUndoManager, undoDepth } from '../index.js';

const ME: Author = { id: 'u1', kind: 'user', name: '我' };
const AI: Author = { id: 'agent', kind: 'ai', name: 'AI' };
const OTHER: Author = { id: 'u2', kind: 'user', name: '同伴' };

const setup = () => {
  const scene = new Scene();
  return { scene, undo: createUndoManager(scene) };
};

describe('一次动作 = 一次撤销', () => {
  it('一次 create 画出的十几个图元，一次撤销全部消失', () => {
    const { scene, undo } = setup();
    scene.create(
      Array.from({ length: 12 }, (_, i) => ({ type: 'rect' as const, x: i * 10, y: 0, w: 8, h: 8 })),
      { author: AI },
    );
    expect(scene.size).toBe(12);

    undo.undo();
    expect(scene.size).toBe(0);
  });

  it('两笔独立的笔画不会被并成一步（Yjs 默认 500ms 合并，已关掉）', () => {
    const { scene, undo } = setup();
    scene.create([{ type: 'freedraw', x: 0, y: 0, points: [[0, 0], [5, 5]] }], { author: ME });
    scene.create([{ type: 'freedraw', x: 20, y: 0, points: [[0, 0], [5, 5]] }], { author: ME });
    expect(scene.size).toBe(2);

    undo.undo();
    expect(scene.size).toBe(1); // 只撤掉第二笔
    undo.undo();
    expect(scene.size).toBe(0);
  });

  it('撤销的粒度与 opId 一致', () => {
    const { scene, undo } = setup();
    const a = scene.create([{ type: 'rect', x: 0, y: 0, w: 5, h: 5 }, { type: 'rect', x: 9, y: 0, w: 5, h: 5 }], { author: ME });
    const b = scene.create([{ type: 'ellipse', x: 0, y: 20, w: 5, h: 5 }], { author: ME });
    expect(new Set(scene.all().map((s) => s.opId)).size).toBe(2);

    undo.undo();
    expect(scene.all().every((s) => s.opId === a.diff.opId)).toBe(true);
    expect(scene.all()).toHaveLength(2);
    void b;
  });
});

describe('撤销范围', () => {
  it('能撤销 AI 的动作', () => {
    const { scene, undo } = setup();
    scene.create([{ type: 'polygon', x: 0, y: 0, points: [[0, 0], [10, 0], [5, 8]], meta: { role: 'roof' } }], {
      author: AI,
    });
    expect(scene.byLayer('ai')).toHaveLength(1);

    undo.undo();
    expect(scene.byLayer('ai')).toHaveLength(0);
  });

  it('不会撤销别的协作者的动作', () => {
    const { scene, undo } = setup();
    // 远端来的改动：origin 是 remote，不在追踪范围内
    scene.create([{ type: 'rect', id: 'sh_theirs', x: 0, y: 0, w: 5, h: 5 }], {
      author: OTHER,
      origin: ORIGIN_REMOTE,
    });
    scene.create([{ type: 'rect', id: 'sh_mine', x: 20, y: 0, w: 5, h: 5 }], { author: ME });

    undo.undo();
    expect(scene.has('sh_mine')).toBe(false);
    expect(scene.has('sh_theirs')).toBe(true); // 别人的内容不许动

    undo.undo(); // 再撤一次也不该碰到它
    expect(scene.has('sh_theirs')).toBe(true);
  });

  it('我的和 AI 的混在一起时，按时间倒序逐个撤销', () => {
    const { scene, undo } = setup();
    scene.create([{ type: 'rect', id: 'wall', x: 0, y: 0, w: 20, h: 10 }], { author: ME });
    scene.create([{ type: 'polygon', id: 'roof', x: 0, y: 0, points: [[0, 0], [20, 0], [10, 8]] }], { author: AI });

    undo.undo();
    expect(scene.has('roof')).toBe(false);
    expect(scene.has('wall')).toBe(true);

    undo.undo();
    expect(scene.has('wall')).toBe(false);
  });
});

describe('撤销各类改动', () => {
  it('撤销删除会把图元原样恢复', () => {
    const { scene, undo } = setup();
    const { ids } = scene.create([{ type: 'rect', x: 3, y: 4, w: 50, h: 60, meta: { role: 'wall' } }], { author: ME });
    const before = scene.get(ids[0]!)!;

    scene.delete(ids, { origin: ORIGIN_LOCAL });
    expect(scene.size).toBe(0);

    undo.undo();
    const after = scene.get(ids[0]!)!;
    expect(after).toBeDefined();
    expect([after.x, after.y, after.w, after.h]).toEqual([before.x, before.y, before.w, before.h]);
    expect(after.meta.role).toBe('wall');
  });

  it('撤销移动会还原到原位置', () => {
    const { scene, undo } = setup();
    const { ids } = scene.create([{ type: 'rect', x: 10, y: 10, w: 5, h: 5 }], { author: ME });
    scene.update([{ id: ids[0]!, set: { x: 999, y: 888 } }], { origin: ORIGIN_LOCAL });
    expect(scene.get(ids[0]!)!.x).toBe(999);

    undo.undo();
    expect(scene.get(ids[0]!)!.x).toBe(10);
    expect(scene.get(ids[0]!)!.y).toBe(10);
  });

  it('撤销 AI 的样式修改会还原旧样式', () => {
    const { scene, undo } = setup();
    const { ids } = scene.create([{ type: 'rect', x: 0, y: 0, w: 5, h: 5, style: { stroke: '#000' } }], { author: AI });
    scene.update([{ id: ids[0]!, set: { style: { stroke: '#f00' } } }], { origin: ORIGIN_AI });
    expect(scene.get(ids[0]!)!.style.stroke).toBe('#f00');

    undo.undo();
    expect(scene.get(ids[0]!)!.style.stroke).toBe('#000');
  });
});

describe('重做', () => {
  it('撤销之后能重做回来', () => {
    const { scene, undo } = setup();
    scene.create([{ type: 'rect', id: 'x', x: 0, y: 0, w: 5, h: 5 }], { author: ME });

    undo.undo();
    expect(scene.has('x')).toBe(false);
    undo.redo();
    expect(scene.has('x')).toBe(true);
  });

  it('撤销后又有新动作，重做栈就清空了', () => {
    const { scene, undo } = setup();
    scene.create([{ type: 'rect', id: 'a', x: 0, y: 0, w: 5, h: 5 }], { author: ME });
    undo.undo();
    expect(undoDepth(undo).redo).toBe(1);

    scene.create([{ type: 'rect', id: 'b', x: 0, y: 0, w: 5, h: 5 }], { author: ME });
    expect(undoDepth(undo).redo).toBe(0);
  });

  it('栈深度反映可撤销/可重做的步数', () => {
    const { scene, undo } = setup();
    expect(undoDepth(undo)).toEqual({ undo: 0, redo: 0 });

    scene.create([{ type: 'rect', x: 0, y: 0, w: 5, h: 5 }], { author: ME });
    scene.create([{ type: 'rect', x: 9, y: 0, w: 5, h: 5 }], { author: ME });
    expect(undoDepth(undo)).toEqual({ undo: 2, redo: 0 });

    undo.undo();
    expect(undoDepth(undo)).toEqual({ undo: 1, redo: 1 });
  });

  it('空栈上撤销不会出错', () => {
    const { scene, undo } = setup();
    expect(() => undo.undo()).not.toThrow();
    expect(scene.size).toBe(0);
  });
});

describe('与协同并存', () => {
  it('撤销产生的改动会同步给其他端', () => {
    const a = new Scene();
    const undo = createUndoManager(a);
    const b = new Scene();

    a.create([{ type: 'rect', id: 'sh_x', x: 0, y: 0, w: 5, h: 5 }], { author: ME });
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    expect(b.has('sh_x')).toBe(true);

    undo.undo();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
    expect(b.has('sh_x')).toBe(false);
  });
});
