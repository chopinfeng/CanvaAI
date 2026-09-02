import { describe, expect, it } from 'vitest';
import { Scene } from '@canvai/canvas-core';
import { call, makeHarness } from './harness.js';

/**
 * 真机复现（drill-g5-4）：diagramBlockCount 逼着模型往图形附近写一段真内容，
 * 那一片被图形本身的边和标签占得很满，新文字反复被 findTextCollision/
 * findLineCrossing 拦下；模型没有去修正坐标，而是每次换个新位置、一字不改地
 * 把同一句"最终结果：AD = 7，∠BFD = 60°"再写一遍——连写了 11 次，从图形正
 * 下方一路铺到画布外面去。两道碰撞检查都拦不住这个：11 份拷贝彼此隔得够开，
 * 没有一条会被判定为"压住"或"穿过"。
 */
describe('新写的文字不能和板书上已有的一字不差', () => {
  it('同一句话换个位置又写一遍——被拒', async () => {
    const scene = new Scene();
    scene.create(
      [{ type: 'text', id: 'sh_prev', x: 639, y: 600, text: '最终结果：AD = 7，∠BFD = 60°' }],
      { author: { id: 'ai', kind: 'ai' }, layer: 'ai' },
    );
    const h = makeHarness(
      [{ calls: [call('canvas_create', { shapes: [{ type: 'text', x: 639, y: 900, text: '最终结果：AD = 7，∠BFD = 60°' }] })] }],
      { scene },
    );
    h.loop.push({ kind: 'text', text: '再写一遍最终结果', at: Date.now() });
    await h.loop.drain();

    const create = h.events('agent.tool').filter((m) => m.call.name === 'canvas_create').at(-1)!;
    expect(create.call.state).toBe('error');
    expect(create.call.error).toContain('一字不差');
  });

  it('短标签（60°）在图上不同位置重复出现——放行', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_prev', x: 100, y: 100, text: '60°' }], {
      author: { id: 'ai', kind: 'ai' },
      layer: 'ai',
    });
    const h = makeHarness(
      [{ calls: [call('canvas_create', { shapes: [{ type: 'text', x: 500, y: 500, text: '60°' }] })] }],
      { scene },
    );
    h.loop.push({ kind: 'text', text: '在另一个角也标 60°', at: Date.now() });
    await h.loop.drain();

    const create = h.events('agent.tool').filter((m) => m.call.name === 'canvas_create').at(-1)!;
    expect(create.call.state).toBe('ok');
  });

  it('新内容和已有内容只是长得像、不是一字不差——放行', async () => {
    const scene = new Scene();
    scene.create(
      [{ type: 'text', id: 'sh_prev', x: 100, y: 100, text: '最终结果：AD = 7，∠BFD = 60°' }],
      { author: { id: 'ai', kind: 'ai' }, layer: 'ai' },
    );
    const h = makeHarness(
      [{ calls: [call('canvas_create', { shapes: [{ type: 'text', x: 500, y: 500, text: '第(2)问：AD = 7' }] })] }],
      { scene },
    );
    h.loop.push({ kind: 'text', text: '写第(2)问的答案', at: Date.now() });
    await h.loop.drain();

    const create = h.events('agent.tool').filter((m) => m.call.name === 'canvas_create').at(-1)!;
    expect(create.call.state).toBe('ok');
  });
});
