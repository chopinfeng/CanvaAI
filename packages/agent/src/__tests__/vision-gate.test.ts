import { describe, expect, it } from 'vitest';
import { Scene } from '@canvai/canvas-core';
import { ToolRegistry } from '../tools/registry.js';
import { call, makeHarness } from './harness.js';

/**
 * 没有视觉模型时，canvas_snapshot 是个陷阱：它"成功"返回一堆结构化描述，
 * 模型以为再试一次就能看清，于是连调五次（实测）。
 * 所以直接把工具摘掉；万一还是被调到（比如从漏成正文的调用里还原出来），
 * 也要明确报错并指路，而不是又一次"降级成功"。
 */

describe('无视觉模型时的截图工具', () => {
  it('可以从工具列表里摘掉', () => {
    const full = new ToolRegistry().functionSchemas().map((s) => s.function.name);
    const gated = new ToolRegistry(undefined, undefined, { exclude: ['canvas_snapshot'] })
      .functionSchemas()
      .map((s) => s.function.name);

    expect(full).toContain('canvas_snapshot');
    expect(gated).not.toContain('canvas_snapshot');
    expect(gated.length).toBe(full.length - 1);
  });

  it('摘掉后仍在的工具一个不少', () => {
    const gated = new ToolRegistry(undefined, undefined, { exclude: ['canvas_snapshot'] });
    for (const name of ['canvas_query', 'canvas_describe', 'canvas_measure', 'interact_ask_user']) {
      expect(gated.has(name), name).toBe(true);
    }
  });

  it('定义与实现的一一对应校验不受排除影响', () => {
    expect(() => new ToolRegistry(undefined, undefined, { exclude: ['canvas_snapshot'] })).not.toThrow();
    // 排除一个不存在的名字也不该炸
    expect(() => new ToolRegistry(undefined, undefined, { exclude: ['no_such_tool'] })).not.toThrow();
  });

  it('若仍被调到，报错而不是降级成功，并指向可用的替代做法', async () => {
    const h = makeHarness([
      { calls: [call('canvas_snapshot', { describe: true })] },
      { text: '换个办法' },
    ]);
    h.loop.push({ kind: 'text', text: '看看图里是什么', at: Date.now() });
    await h.loop.drain();

    const payload = JSON.parse(h.loop.getHistory().find((m) => m.role === 'tool')!.content as string);
    expect(payload.ok).toBe(false);
    expect(payload.hint).toContain('onImages');
    expect(payload.hint).toContain('问用户');
  });
});

/**
 * 真机录像复现过两次同一条链路：canvas_create 撞了已有内容被拦下，
 * 模型按提示词去 canvas_snapshot 核对该往哪写，视觉模型恰好被上游
 * 限流（429），异常直接冒泡成一堆没有指引的错误堆栈甩给模型——模型
 * 收到之后不知道怎么办，从此彻底沉默，直到空闲超时把整场辅导收场。
 * 视觉模型调用不该有这条死路：跟 rasterizer 渲染失败时一样，退化成
 * 结构化描述——图元的精确边界框本身就够用来判断"还有多少空间"。
 */
describe('视觉模型调用失败——退化，不是死路', () => {
  it('视觉模型抛错（比如限流）时，退化成结构化描述而不是报错卡死', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness([{ calls: [call('canvas_snapshot', { describe: true })] }, { text: '好' }], {
      scene,
      rasterizer: { render: async () => new Uint8Array([1, 2, 3]) },
      vision: {
        describe: async () => {
          throw new Error('视觉模型返回 429：上游限流');
        },
      },
    });
    h.loop.push({ kind: 'text', text: '看看板书写到哪儿了', at: Date.now() });
    await h.loop.drain();

    const payload = JSON.parse(h.loop.getHistory().find((m) => m.role === 'tool')!.content as string);
    expect(payload.ok).toBe(true);
    expect(payload.data.degraded).toBe(true);
    expect(payload.data.note).toContain('429');
    expect(payload.data.shapes.length).toBeGreaterThan(0);
  });
});
