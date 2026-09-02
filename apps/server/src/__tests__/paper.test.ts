import { describe, expect, it, vi } from 'vitest';
import { Scene } from '@canvai/canvas-core';
import type { ServerMessage } from '@canvai/protocol';

/**
 * 传试卷这条路一直没有测试——之前完全靠真机点一遍。
 *
 * 这一条专门盯着一处真机复现出来的缺口：转换完之后不会自动把镜头带过去。
 * 原图和转换结果左右并排放，两块加起来铺出接近 1700px 宽，默认相机停在
 * (0,0)，用户打开页面十有八九只看得到左边原图那一半——右边"识别结果，
 * 请核对"完全在视口外面，而那正是这条功能最要用户去核对的部分。
 */

vi.mock('../assets.ts', () => ({
  readAsset: vi.fn(async () => ({ bytes: Buffer.from([1, 2, 3]), mime: 'image/png' })),
}));

vi.mock('../vision.ts', () => ({
  makeVisionProvider: () => ({
    describe: vi.fn(
      async () =>
        '```json\n' +
        JSON.stringify({
          statement: '已知 sin α = 3/5，且 α 是第二象限角。(1) 求 cos α。',
          known: { 'sin α': '3/5' },
          asks: ['求 cos α'],
          topic: '三角恒等变换',
        }) +
        '\n```',
    ),
  }),
}));

describe('传试卷：转完自动把镜头带过去', () => {
  it('emit 一条 agent.viewport，覆盖新插入的全部内容——不用等用户自己去找', async () => {
    const { importPaper } = await import('../paper.ts');
    const scene = new Scene();
    const emitted: ServerMessage[] = [];

    const result = await importPaper(scene, 'as_test', {}, (m) => emitted.push(m));
    expect(result).not.toBeNull();

    const viewport = emitted.find((m) => m.t === 'agent.viewport');
    expect(viewport).toBeDefined();
    expect(viewport!.animate).toBe(true);

    // 覆盖范围要包住这次真正创建出来的每一个图元，一个都不能漏在外面
    const [vx, vy, vw, vh] = viewport!.rect!;
    for (const id of result!.shapeIds) {
      const s = scene.get(id)!;
      const [sx, sy, sw, sh] = [s.x, s.y, (s as { w?: number }).w ?? 0, (s as { h?: number }).h ?? 0];
      expect(sx).toBeGreaterThanOrEqual(vx - 1);
      expect(sy).toBeGreaterThanOrEqual(vy - 1);
      expect(sx + sw).toBeLessThanOrEqual(vx + vw + 1);
      expect(sy + sh).toBeLessThanOrEqual(vy + vh + 1);
    }

    // 视口本身要跨过原图（左）和转换结果（右）两块——不能只镜头带到其中一半
    expect(vw).toBeGreaterThan(900);
  });

  it('这条消息排在 done 之前——用户看见"核对一下数值"的同时镜头已经到位', async () => {
    const { importPaper } = await import('../paper.ts');
    const scene = new Scene();
    const emitted: ServerMessage[] = [];

    await importPaper(scene, 'as_test', {}, (m) => emitted.push(m));

    const viewportAt = emitted.findIndex((m) => m.t === 'agent.viewport');
    const doneAt = emitted.findIndex((m) => m.t === 'paper.progress' && m.phase === 'done');
    expect(viewportAt).toBeGreaterThanOrEqual(0);
    expect(doneAt).toBeGreaterThan(viewportAt);
  });
});
