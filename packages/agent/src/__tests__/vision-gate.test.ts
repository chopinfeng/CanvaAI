import { describe, expect, it } from 'vitest';
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
