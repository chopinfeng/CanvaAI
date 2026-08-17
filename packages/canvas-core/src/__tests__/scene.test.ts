import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Author } from '@canvai/protocol';
import { ORIGIN_AI, Scene } from '../scene.js';
import { sceneToSvg } from '../svg.js';

const AI: Author = { id: 'agent', kind: 'ai', name: 'Claude' };
const USER: Author = { id: 'u1', kind: 'user', name: '我' };

describe('Scene 基础', () => {
  it('创建的图元共享一个 opId —— 一次撤销的粒度', () => {
    const scene = new Scene();
    const { ids, diff } = scene.create(
      [
        { type: 'rect', x: 0, y: 0, w: 10, h: 10 },
        { type: 'rect', x: 20, y: 0, w: 10, h: 10 },
      ],
      { author: AI },
    );
    expect(ids).toHaveLength(2);
    expect(scene.get(ids[0]!)!.opId).toBe(scene.get(ids[1]!)!.opId);
    expect(diff.created).toEqual(ids);
  });

  it('AI 创建默认落 ai 图层，用户创建落 user 图层', () => {
    const scene = new Scene();
    const { ids: aiIds } = scene.create([{ type: 'rect', x: 0, y: 0, w: 1, h: 1 }], { author: AI });
    const { ids: userIds } = scene.create([{ type: 'rect', x: 0, y: 0, w: 1, h: 1 }], { author: USER });
    expect(scene.get(aiIds[0]!)!.layer).toBe('ai');
    expect(scene.get(userIds[0]!)!.layer).toBe('user');
  });

  it('update 对 style/meta 做浅合并，不会互相冲掉', () => {
    const scene = new Scene();
    const { ids } = scene.create(
      [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, style: { stroke: '#000', strokeWidth: 3 } }],
      { author: USER },
    );
    scene.update([{ id: ids[0]!, set: { style: { stroke: '#f00' } } }]);
    const s = scene.get(ids[0]!)!;
    expect(s.style.stroke).toBe('#f00');
    expect(s.style.strokeWidth).toBe(3); // 没被冲掉
  });

  it('promoteOp 把整组提案搬到 ai 层', () => {
    const scene = new Scene();
    const { ids, diff } = scene.create(
      [{ type: 'rect', x: 0, y: 0, w: 1, h: 1 }, { type: 'rect', x: 5, y: 0, w: 1, h: 1 }],
      { author: AI, layer: 'suggest' },
    );
    expect(scene.get(ids[0]!)!.layer).toBe('suggest');
    scene.promoteOp(diff.opId, 'ai');
    expect(scene.byLayer('ai').map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(scene.byLayer('suggest')).toHaveLength(0);
  });

  it('渲染顺序先按图层再按 z', () => {
    const scene = new Scene();
    scene.create([{ type: 'rect', x: 0, y: 0, w: 1, h: 1, id: 'sug' }], { author: AI, layer: 'suggest' });
    scene.create([{ type: 'rect', x: 0, y: 0, w: 1, h: 1, id: 'usr' }], { author: USER });
    scene.create([{ type: 'rect', x: 0, y: 0, w: 1, h: 1, id: 'aiv' }], { author: AI });
    expect(scene.all().map((s) => s.id)).toEqual(['usr', 'aiv', 'sug']);
  });

  it('contentBounds 覆盖所有内容', () => {
    const scene = new Scene();
    scene.create(
      [
        { type: 'rect', x: 0, y: 0, w: 100, h: 100 },
        { type: 'rect', x: 200, y: 50, w: 100, h: 100 },
      ],
      { author: USER },
    );
    expect(scene.contentBounds()).toEqual([0, 0, 300, 150]);
  });
});

describe('CRDT 协同', () => {
  it('两端并发改同一图元的不同字段，双方都保留', () => {
    const a = new Scene();
    const { ids } = a.create([{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }], { author: USER });
    const id = ids[0]!;

    const b = new Scene();
    Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));

    // A 拖动位置，B 同时改颜色
    a.update([{ id, set: { x: 500 } }]);
    b.update([{ id, set: { style: { stroke: '#f00' } } }]);

    const updA = Y.encodeStateAsUpdate(a.doc);
    const updB = Y.encodeStateAsUpdate(b.doc);
    Y.applyUpdate(a.doc, updB);
    Y.applyUpdate(b.doc, updA);

    for (const scene of [a, b]) {
      const s = scene.get(id)!;
      expect(s.x).toBe(500);
      expect(s.style.stroke).toBe('#f00');
    }
  });

  it('onChange 能区分改动来源', () => {
    const scene = new Scene();
    const seen: unknown[] = [];
    scene.onChange(({ origin }) => seen.push(origin));
    scene.create([{ type: 'rect', x: 0, y: 0, w: 1, h: 1 }], { author: AI });
    expect(seen).toEqual([ORIGIN_AI]);
  });
});

describe('SVG 序列化', () => {
  it('输出可光栅化的 SVG', () => {
    const scene = new Scene();
    scene.create(
      [
        { type: 'rect', x: 100, y: 200, w: 200, h: 150, meta: { role: 'wall' } },
        { type: 'polygon', x: 0, y: 0, points: [[80, 200], [200, 110], [320, 200]], closed: true },
        { type: 'text', x: 120, y: 400, text: '房子' },
      ],
      { author: USER },
    );
    const svg = sceneToSvg(scene.all());
    expect(svg).toContain('<svg');
    expect(svg).toContain('<rect');
    expect(svg).toContain('<path');
    expect(svg).toContain('房子');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('annotateIds 给视觉模型标出图元 id', () => {
    const scene = new Scene();
    scene.create([{ type: 'rect', x: 0, y: 0, w: 10, h: 10, id: 'sh_test' }], { author: USER });
    expect(sceneToSvg(scene.all(), { annotateIds: true })).toContain('sh_test');
  });
});
