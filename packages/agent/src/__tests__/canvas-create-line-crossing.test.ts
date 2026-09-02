import { describe, expect, it } from 'vitest';
import { Scene } from '@canvai/canvas-core';
import { call, makeHarness } from './harness.js';

/**
 * 用户直接在板书截图里看出来的问题："这次的板书又覆盖到图形上了"——
 * "图案得挨着题目图形"那道闸只查包围盒相交，逼着模型把文字写进了
 * 三角形内部，结果新文字被三角形自己的边、高线正中间划了过去，读不出
 * 来。这道检查跟"新文字压住旧文字"是两个方向：挨着图形写没问题，
 * 写的位置正好被具体某条边划过去才是问题。
 */
describe('新写的文字不能被一条已有的线正中间划过去', () => {
  it('文字压在一条已有线段正中间——被拒', async () => {
    const scene = new Scene();
    // 一条从 (0,0) 到 (100,100) 的线，贴着中心点画一段文字
    scene.create([{ type: 'line', id: 'sh_edge', x: 0, y: 0, points: [[0, 0], [100, 100]] }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [{ calls: [call('canvas_create', { shapes: [{ type: 'text', x: 30, y: 40, w: 40, h: 20, text: 'BD=5' }] })] }],
      { scene },
    );
    h.loop.push({ kind: 'text', text: '在图上标一下 BD=5', at: Date.now() });
    await h.loop.drain();

    const create = h.events('agent.tool').filter((m) => m.call.name === 'canvas_create').at(-1)!;
    expect(create.call.state).toBe('error');
    expect(create.call.error).toContain('正中间穿过去了');
  });

  it('文字挨着图形写、但落在图形内部的空白角落——放行', async () => {
    const scene = new Scene();
    // 三角形一条边 (0,100)→(50,0)：包围盒盖住一大片区域，
    // 但这段文字落在离那条斜线还有一截距离的空白角落
    scene.create([{ type: 'line', id: 'sh_edge', x: 0, y: 0, points: [[0, 100], [50, 0]] }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [{ calls: [call('canvas_create', { shapes: [{ type: 'text', x: 30, y: 80, w: 15, h: 15, text: 'D' }] })] }],
      { scene },
    );
    h.loop.push({ kind: 'text', text: '标一下 D 点', at: Date.now() });
    await h.loop.drain();

    const create = h.events('agent.tool').filter((m) => m.call.name === 'canvas_create').at(-1)!;
    expect(create.call.state).toBe('ok');
  });

  it('挨着一个矩形（框）写字——不受影响，矩形不算"线"', async () => {
    const scene = new Scene();
    scene.create([{ type: 'rect', id: 'sh_box', x: 0, y: 0, w: 100, h: 100 }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [{ calls: [call('canvas_create', { shapes: [{ type: 'text', x: 30, y: 40, w: 40, h: 20, text: 'x = 1' }] })] }],
      { scene },
    );
    h.loop.push({ kind: 'text', text: '在框里写点东西', at: Date.now() });
    await h.loop.drain();

    const create = h.events('agent.tool').filter((m) => m.call.name === 'canvas_create').at(-1)!;
    expect(create.call.state).toBe('ok');
  });
});
