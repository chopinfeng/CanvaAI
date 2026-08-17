import { describe, expect, it } from 'vitest';
import { Scene, shapeBounds } from '@canvai/canvas-core';
import { SYSTEM_PROMPT } from '../prompt.js';
import { ToolRegistry } from '../tools/registry.js';
import { USER, call, makeHarness } from './harness.js';

describe('工具注册表', () => {
  it('定义与实现一一对应', () => {
    expect(() => new ToolRegistry()).not.toThrow();
  });

  it('function schema 数量与工具数一致', () => {
    const r = new ToolRegistry();
    const schemas = r.functionSchemas();
    expect(schemas.length).toBeGreaterThan(20);
    expect(schemas.every((s) => s.type === 'function' && s.function.name && s.function.description)).toBe(true);
  });
});

describe('「在房子上画个屋顶」完整闭环', () => {
  it('先查后画，屋顶落 ai 层并带语义标记', async () => {
    const scene = new Scene();
    // 用户已经画好了墙
    scene.create([{ type: 'rect', id: 'sh_wall', x: 100, y: 300, w: 200, h: 150, meta: { role: 'wall' } }], {
      author: USER,
    });

    const h = makeHarness(
      [
        { calls: [call('canvas_query', { limit: 30 })] },
        { calls: [call('canvas_describe', { ids: ['sh_wall'], detail: 'full' })] },
        {
          calls: [
            call('canvas_pointer_move', { to: { x: 200, y: 280 }, ms: 10 }),
            call('canvas_create', {
              shapes: [
                {
                  type: 'polygon',
                  x: 0,
                  y: 0,
                  points: [[80, 300], [200, 210], [320, 300]],
                  closed: true,
                  meta: { role: 'roof', refs: ['sh_wall'] },
                },
              ],
            }),
            call('interact_say', { text: '给你加了个三角屋顶' }),
          ],
        },
        { text: '好了。' },
      ],
      { scene },
    );

    h.loop.push({ kind: 'text', text: '在这个房子上面画个屋顶', at: Date.now() });
    await h.loop.drain();

    const roof = scene.all().find((s) => s.meta.role === 'roof');
    expect(roof).toBeDefined();
    expect(roof!.layer).toBe('ai');
    expect(roof!.type).toBe('polygon');
    expect(roof!.meta.refs).toEqual(['sh_wall']);

    // 用户的墙没被动过
    expect(scene.get('sh_wall')!.layer).toBe('user');
    expect(scene.byLayer('user')).toHaveLength(1);
  });

  it('同一次 create 的图元共享 opId —— 用户一次撤销', async () => {
    const h = makeHarness([
      {
        calls: [
          call('canvas_create', {
            shapes: [
              { type: 'line', x: 0, y: 0, points: [[0, 0], [100, 0]] },
              { type: 'line', x: 0, y: 0, points: [[100, 0], [50, -60]] },
              { type: 'line', x: 0, y: 0, points: [[50, -60], [0, 0]] },
            ],
          }),
        ],
      },
    ]);
    h.loop.push({ kind: 'text', text: '画个三角形', at: Date.now() });
    await h.loop.drain();

    const opIds = new Set(h.scene.all().map((s) => s.opId));
    expect(h.scene.size).toBe(3);
    expect(opIds.size).toBe(1);
  });

  it('落笔前先移动光标，前端会收到 pointer 事件', async () => {
    const h = makeHarness([
      { calls: [call('canvas_pointer_move', { to: { x: 300, y: 200 }, ms: 10 })] },
      { text: '到位了' },
    ]);
    h.loop.push({ kind: 'text', text: '看这里', at: Date.now() });
    await h.loop.drain();

    const ptr = h.events('agent.pointer');
    expect(ptr).toHaveLength(1);
    expect(ptr[0]!.to).toEqual({ x: 300, y: 200 });
  });
});

describe('坐标约定 —— points 一律是画布绝对坐标', () => {
  /** 屋顶要正好压在 bbox 为 [320,384,208,160] 的墙顶边上 */
  const ROOF = [
    [320, 384],
    [424, 300],
    [528, 384],
  ];

  const roofBounds = (scene: Scene) => {
    const roof = scene.all().find((s) => s.meta.role === 'roof')!;
    return shapeBounds(roof).map(Math.round);
  };

  it('只给 points、不给 x/y 时落在正确位置', async () => {
    const h = makeHarness([
      {
        calls: [
          call('canvas_create', {
            shapes: [{ type: 'polygon', points: ROOF, closed: true, meta: { role: 'roof' }, style: { strokeWidth: 0 } }],
          }),
        ],
      },
    ]);
    h.loop.push({ kind: 'text', text: '加屋顶', at: Date.now() });
    await h.loop.drain();
    expect(roofBounds(h.scene)).toEqual([320, 300, 208, 84]);
  });

  it('模型多给了 x/y 也不会二次偏移', async () => {
    // 这是真实模型踩过的坑：既给绝对 points，又顺手填了 x/y
    const h = makeHarness([
      {
        calls: [
          call('canvas_create', {
            shapes: [
              { type: 'polygon', x: 320, y: 300, points: ROOF, closed: true, meta: { role: 'roof' }, style: { strokeWidth: 0 } },
            ],
          }),
        ],
      },
    ]);
    h.loop.push({ kind: 'text', text: '加屋顶', at: Date.now() });
    await h.loop.drain();
    expect(roofBounds(h.scene)).toEqual([320, 300, 208, 84]);
  });

  it('手绘压感值在换算中保留', async () => {
    const h = makeHarness([
      {
        calls: [
          call('canvas_create', {
            shapes: [{ type: 'freedraw', points: [[100, 100, 0.3], [140, 130, 0.9]], meta: { role: 'sketch' } }],
          }),
        ],
      },
    ]);
    h.loop.push({ kind: 'text', text: '描一笔', at: Date.now() });
    await h.loop.drain();

    const s = h.scene.all().find((x) => x.meta.role === 'sketch')!;
    expect(s.x).toBe(100);
    expect(s.points).toEqual([[0, 0, 0.3], [40, 30, 0.9]]);
  });

  it('矩形缺 x/y 会被拒绝，并说清楚该怎么写', async () => {
    const h = makeHarness([
      { calls: [call('canvas_create', { shapes: [{ type: 'rect', w: 10, h: 10 }] })] },
      { text: '补上位置' },
    ]);
    h.loop.push({ kind: 'text', text: '画方块', at: Date.now() });
    await h.loop.drain();

    const payload = JSON.parse(h.loop.getHistory().find((m) => m.role === 'tool')!.content as string);
    expect(payload.ok).toBe(false);
    expect(payload.hint).toContain('x/y/w/h');
  });
});

describe('图层权限 —— AI 不能毁掉用户的东西', () => {
  it('拒绝修改 user 图层，并给出可执行的 hint', async () => {
    const scene = new Scene();
    scene.create([{ type: 'rect', id: 'sh_mine', x: 0, y: 0, w: 50, h: 50 }], { author: USER });

    const h = makeHarness(
      [
        { calls: [call('canvas_update', { patches: [{ id: 'sh_mine', set: { x: 999 } }] })] },
        { text: '我不能直接改你的图形' },
      ],
      { scene },
    );
    h.loop.push({ kind: 'text', text: '把它移到右边', at: Date.now() });
    await h.loop.drain();

    expect(scene.get('sh_mine')!.x).toBe(0); // 没被改动

    const toolEvents = h.events('agent.tool').filter((e) => e.call.state === 'error');
    expect(toolEvents).toHaveLength(1);

    // hint 必须告诉模型下一步怎么办
    const hist = h.loop.getHistory();
    const toolMsg = hist.find((m) => m.role === 'tool');
    const payload = JSON.parse(toolMsg!.content as string);
    expect(payload.ok).toBe(false);
    expect(payload.hint).toContain('suggest');
  });

  it('direct 模式 + force 时允许修改', async () => {
    const scene = new Scene();
    scene.create([{ type: 'rect', id: 'sh_mine', x: 0, y: 0, w: 50, h: 50 }], { author: USER });

    const h = makeHarness(
      [{ calls: [call('canvas_update', { patches: [{ id: 'sh_mine', set: { x: 999 } }], force: true })] }],
      { scene, session: { editMode: 'direct' } },
    );
    h.loop.push({ kind: 'text', text: '直接改', at: Date.now() });
    await h.loop.drain();

    expect(scene.get('sh_mine')!.x).toBe(999);
  });

  it('不能清空 user 图层', async () => {
    const scene = new Scene();
    scene.create([{ type: 'rect', x: 0, y: 0, w: 10, h: 10 }], { author: USER });
    const h = makeHarness([{ calls: [call('canvas_layer_clear', { id: 'user' })] }], { scene });
    h.loop.push({ kind: 'text', text: '全清了', at: Date.now() });
    await h.loop.drain();
    expect(scene.byLayer('user')).toHaveLength(1);
  });
});

describe('提案流程', () => {
  it('画在 suggest 层 → 提交确认 → 用户接受后 promote 到 ai 层', async () => {
    const h = makeHarness([
      {
        calls: [
          call('canvas_create', {
            layer: 'suggest',
            shapes: [{ type: 'ellipse', x: 10, y: 10, w: 40, h: 40, meta: { role: 'window' } }],
          }),
        ],
      },
      { calls: [] },
    ]);
    h.loop.push({ kind: 'text', text: '加个窗户', at: Date.now() });
    await h.loop.drain();

    const suggested = h.scene.byLayer('suggest');
    expect(suggested).toHaveLength(1);
    const opId = suggested[0]!.opId;

    // 用户点了「接受」，服务端调 promoteOp
    h.scene.promoteOp(opId, 'ai');
    expect(h.scene.byLayer('suggest')).toHaveLength(0);
    expect(h.scene.byLayer('ai')).toHaveLength(1);
  });

  it('interact_suggest 引用不存在的 opId 时给出正确 hint', async () => {
    const h = makeHarness([
      { calls: [call('interact_suggest', { opId: 'op_nope', summary: '瞎提的' })] },
      { text: '出错了' },
    ]);
    h.loop.push({ kind: 'text', text: '提案', at: Date.now() });
    await h.loop.drain();

    const toolMsg = h.loop.getHistory().find((m) => m.role === 'tool');
    const payload = JSON.parse(toolMsg!.content as string);
    expect(payload.ok).toBe(false);
    expect(payload.hint).toContain('canvas_create');
  });
});

describe('错误恢复', () => {
  it('参数不合法时返回 hint 而不是抛异常', async () => {
    const h = makeHarness([
      { calls: [call('canvas_create', { shapes: [{ type: 'rect', x: 0, y: 0 }] })] }, // 缺 w/h
      { text: '补上尺寸重画' },
    ]);
    h.loop.push({ kind: 'text', text: '画个方块', at: Date.now() });
    const r = await h.loop.tick();

    expect(r!.reason).toBe('done');
    const payload = JSON.parse(h.loop.getHistory().find((m) => m.role === 'tool')!.content as string);
    expect(payload.ok).toBe(false);
    expect(payload.hint).toContain('x/y/w/h');
  });

  it('调用不存在的工具时列出可用工具', async () => {
    const h = makeHarness([{ calls: [call('canvas_draw_house', {})] }, { text: '换个工具' }]);
    h.loop.push({ kind: 'text', text: '画房子', at: Date.now() });
    await h.loop.drain();

    const payload = JSON.parse(h.loop.getHistory().find((m) => m.role === 'tool')!.content as string);
    expect(payload.ok).toBe(false);
    expect(payload.hint).toContain('canvas_create');
  });

  it('同一工具连续失败 3 次后注入停手指令', async () => {
    const bad = { calls: [call('canvas_describe', { ids: ['sh_ghost'] })] };
    const h = makeHarness([bad, bad, bad, { text: '我卡住了' }]);
    h.loop.push({ kind: 'text', text: '看看那个图形', at: Date.now() });
    await h.loop.drain();

    const nudge = h.loop.getHistory().find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('连续失败了 3 次'),
    );
    expect(nudge).toBeDefined();
  });

  it('撞到 maxSteps 时收尾而不是无限循环', async () => {
    const spin = { calls: [call('canvas_query', {})] };
    const h = makeHarness(Array.from({ length: 20 }, () => spin));
    h.loop.push({ kind: 'text', text: '一直查', at: Date.now() });
    const r = await h.loop.tick();

    expect(r!.reason).toBe('max_steps');
    expect(r!.steps).toBe(8);
  });
});

describe('上下文布局 —— 前缀缓存的前提', () => {
  it('system prompt 逐字不变，且 Context Header 永远在最后', async () => {
    const h = makeHarness([
      { calls: [call('canvas_query', {})] },
      { text: '看完了' },
      { text: '再看一次' },
    ]);

    h.loop.push({ kind: 'text', text: '第一句', at: Date.now() });
    await h.loop.drain();
    h.loop.push({ kind: 'text', text: '第二句', at: Date.now() });
    await h.loop.drain();

    expect(h.model.seen.length).toBeGreaterThanOrEqual(2);
    for (const messages of h.model.seen) {
      expect(messages[0]!.role).toBe('system');
      expect(messages[0]!.content).toBe(SYSTEM_PROMPT);
    }

    // 每一轮的历史都是上一轮的严格前缀扩展（append-only）
    const first = h.model.seen[0]!;
    const last = h.model.seen[h.model.seen.length - 1]!;
    for (let i = 0; i < first.length; i++) {
      expect(last[i]).toEqual(first[i]);
    }

    // 第二轮的 header 里带着新输入
    const header = last.find((m) => m.role === 'user' && String(m.content).includes('第二句'));
    expect(header).toBeDefined();
    expect(String(header!.content)).toContain('[画布]');
  });

  it('Header 带上用户选中的图元', async () => {
    const scene = new Scene();
    scene.create([{ type: 'rect', id: 'sh_sel', x: 0, y: 0, w: 10, h: 10, meta: { role: 'wall' } }], {
      author: USER,
    });
    const h = makeHarness([{ text: 'ok' }], { scene, session: { selection: ['sh_sel'] } });
    h.loop.push({ kind: 'text', text: '把这个改大点', at: Date.now() });
    await h.loop.drain();

    const header = String(h.model.seen[0]!.at(-1)!.content);
    expect(header).toContain('[选中]');
    expect(header).toContain('sh_sel');
    expect(header).toContain('wall');
  });

  it('思维链不进历史', async () => {
    const h = makeHarness([{ text: '答案' }]);
    h.loop.push({ kind: 'text', text: '想一想', at: Date.now() });
    await h.loop.drain();
    const joined = h.loop.getHistory().map((m) => m.content).join('');
    expect(joined).not.toContain('reasoning');
  });
});

describe('说话通道 —— 推理不该冒充答复', () => {
  it('中间步骤的正文标记为 hadTools，最后一步标记为答复', async () => {
    const h = makeHarness([
      { text: '我先看看画布上有什么。', calls: [call('canvas_query', {})] },
      { text: '让我确认一下大矩形的位置。', calls: [call('canvas_get_viewport', {})] },
      { text: '画好了。' },
    ]);
    h.loop.push({ kind: 'text', text: '画个门', at: Date.now() });
    await h.loop.drain();

    const steps = h.events('agent.step');
    expect(steps.map((s) => s.hadTools)).toEqual([true, true, false]);

    // 每段文本都带着自己的 step，客户端据此分流
    const byStep = new Map<number, string>();
    for (const e of h.events('agent.text')) {
      byStep.set(e.step, (byStep.get(e.step) ?? '') + e.delta);
    }
    expect(byStep.get(0)).toBe('我先看看画布上有什么。');
    expect(byStep.get(1)).toBe('让我确认一下大矩形的位置。');
    expect(byStep.get(2)).toBe('画好了。');
  });

  it('interact_say 的内容始终走 agent.say，与推理分开', async () => {
    const h = makeHarness([
      { text: '先量一下再说。', calls: [call('interact_say', { text: '我来给你加个屋顶' })] },
      { text: '' },
    ]);
    h.loop.push({ kind: 'text', text: '加屋顶', at: Date.now() });
    await h.loop.drain();

    const said = h.events('agent.say');
    expect(said).toHaveLength(1);
    expect(said[0]!.text).toBe('我来给你加个屋顶');

    // 推理正文没有混进 say 通道
    expect(said[0]!.text).not.toContain('先量一下');
  });
});

describe('打断', () => {
  it('turn 进行中来了新事件会中断当前 turn', async () => {
    const h = makeHarness([
      { calls: [call('canvas_pointer_move', { to: { x: 0, y: 0 }, ms: 800 })] },
      { text: '继续' },
    ]);

    h.loop.push({ kind: 'text', text: '慢慢画', at: Date.now() });
    const turn = h.loop.tick();
    // 等 turn 真正跑起来
    await new Promise((r) => setTimeout(r, 30));
    h.loop.push({ kind: 'speech', text: '等一下，别画了', at: Date.now() });

    const r = await turn;
    expect(r!.reason).toBe('aborted');

    // 被打断的事件留在队列里，下一轮会处理
    const next = await h.loop.tick();
    expect(next).not.toBeNull();
  });
});

describe('测量工具', () => {
  it('算出两图元中心距离', async () => {
    const scene = new Scene();
    scene.create(
      [
        { type: 'rect', id: 'a', x: 0, y: 0, w: 100, h: 100 },
        { type: 'rect', id: 'b', x: 300, y: 0, w: 100, h: 100 },
      ],
      { author: USER },
    );
    const h = makeHarness([{ calls: [call('canvas_measure', { a: 'a', b: 'b', what: 'distance' })] }, { text: 'ok' }], {
      scene,
    });
    h.loop.push({ kind: 'text', text: '这俩差多远', at: Date.now() });
    await h.loop.drain();

    const payload = JSON.parse(h.loop.getHistory().find((m) => m.role === 'tool')!.content as string);
    expect(payload.ok).toBe(true);
    expect(payload.data.distance).toBe(300);
  });

  it('引用不存在的图元时给出可执行 hint', async () => {
    const h = makeHarness([{ calls: [call('canvas_measure', { a: 'nope', what: 'area' })] }, { text: 'ok' }]);
    h.loop.push({ kind: 'text', text: '面积多少', at: Date.now() });
    await h.loop.drain();

    const payload = JSON.parse(h.loop.getHistory().find((m) => m.role === 'tool')!.content as string);
    expect(payload.ok).toBe(false);
    expect(payload.hint).toContain('canvas_query');
  });
});

describe('连线绑定', () => {
  it('canvas_connect 在两个节点间建立带绑定的箭头', async () => {
    const scene = new Scene();
    scene.create(
      [
        { type: 'rect', id: 'n1', x: 0, y: 0, w: 100, h: 60 },
        { type: 'rect', id: 'n2', x: 300, y: 0, w: 100, h: 60 },
      ],
      { author: USER },
    );
    const h = makeHarness(
      [{ calls: [call('canvas_connect', { from: 'n1', to: 'n2', kind: 'arrow', label: '调用' })] }, { text: 'ok' }],
      { scene },
    );
    h.loop.push({ kind: 'text', text: '把这两个连起来', at: Date.now() });
    await h.loop.drain();

    const arrow = scene.all().find((s) => s.type === 'arrow');
    expect(arrow).toBeDefined();
    expect(arrow!.bindStart?.shapeId).toBe('n1');
    expect(arrow!.bindEnd?.shapeId).toBe('n2');
    // auto 锚点：从 n1 的右边出发，到 n2 的左边
    expect(arrow!.x).toBe(100);
    expect(scene.all().some((s) => s.text === '调用')).toBe(true);
  });
});
