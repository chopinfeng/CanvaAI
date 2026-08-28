import { describe, expect, it } from 'vitest';
import { buildContextHeader } from '../context.js';
import { Scene } from '@canvai/canvas-core';
import type { SessionState } from '../tools/context.js';
import { type Harness, call, makeHarness } from './harness.js';

/**
 * 这一组测的是同一件事：**用户问的题没讲完，辅导就不许结束。**
 *
 * 真实跑下来最容易散的地方是"讲完第 (1) 问、用户说声懂了、模型顺势收尾"。
 * 提示词压不住这种事，所以做成了机制：账（outline）没平就不放行。
 */

/** 每道用例都自动替用户答一句，否则 interact_ask_user 会把回合阻塞到超时 */
const tutor = (steps: Parameters<typeof makeHarness>[0]) => makeHarness(steps, { autoAnswer: '嗯，我算出来了' });

const PLAN = (items: Array<{ text: string; done?: boolean }>) =>
  call('tutor_plan', { items: items.map((i) => ({ text: i.text, done: i.done ?? false })) });

const say = (text: string) => call('interact_say', { text });
const judge = (verdict: 'right' | 'partly' | 'wrong', comment: string) =>
  call('tutor_judge', { verdict, comment });
const ask = (question: string) => call('interact_ask_user', { question });
/** drawnSinceJudge 闸要求判完一轮就得落一笔——跟这道闸无关的测试用它垫上这一笔 */
const draw = () => call('canvas_create', { shapes: [{ type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] }] });
/** zoomedSinceDraw 闸要求画完就得带一次镜头——跟这道闸无关的测试用它垫上 */
const zoomTo = () => call('canvas_zoom_to', { region: [0, 0, 100, 100] });

/** 用户说了句话 → 跑一个回合 */
async function speak(h: Harness, text: string) {
  h.loop.push({ kind: 'text', text, at: Date.now() });
  await h.loop.drain();
}

describe('进入辅导时建账', () => {
  it('记下用户的原话，清单一开始是空的', async () => {
    const h = tutor([{ text: '好的' }]);
    await speak(h, '给我讲这道题');

    expect(h.session.mode).toBe('tutor');
    expect(h.session.tutor?.goal).toBe('给我讲这道题');
    expect(h.session.tutor?.outline).toEqual([]);
  });

  it('辅导中途再说「我不会」不会把进度清零', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('DF 是多少？')] },
      { calls: [judge('right', '对'), PLAN([{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE' }])] },
      { calls: [ask('那 (2) 呢？')] },
      { calls: [judge('partly', '差一点')] },
      { text: '嗯' },
      // 第二个回合：用户说"我不会"，这也命中 enter 规则
      { calls: [ask('那先看这条边？')] },
      { calls: [judge('right', '对')] },
      { text: '嗯' },
    ]);
    await speak(h, '给我讲这道题');
    await speak(h, '我不会');

    expect(h.session.mode).toBe('tutor');
    expect(h.session.tutor?.outline).toEqual([
      { text: '(1) 求 DF', done: true },
      { text: '(2) 求 BE', done: false },
    ]);
  });
});

describe('账没平就不许结束', () => {
  it('没拆过题就想收尾 → 被拒，并要求先拆题', async () => {
    const h = tutor([
      { calls: [call('tutor_finish', { summary: '讲完啦' })] },
      { calls: [ask('那你说说第一步？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    // 每个工具会先发一条 running 再发终态，取最后一条
    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('error');
    expect(finish.call.error).toContain('还没拆过题');
    expect(h.session.mode).toBe('tutor'); // 没被放走
  });

  it('还剩小问就想收尾 → 被拒，错误里点名剩哪些', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF 与 FC' }, { text: '(2) 求线段 BE' }])] },
      { calls: [PLAN([{ text: '(1) 求 DF 与 FC', done: true }, { text: '(2) 求线段 BE' }])] },
      { calls: [call('tutor_finish', { summary: '这道题讲完了' })] },
      { calls: [ask('那 (2) 里 BE 设成 x 的话，EC 是多少？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    // 每个工具会先发一条 running 再发终态，取最后一条
    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('error');
    expect(finish.call.error).toContain('(2) 求线段 BE');
    expect(h.session.mode).toBe('tutor');
    expect(h.session.tutor).not.toBeNull();
  });

  it('全打勾之后才放行：切回普通模式、清掉清单、说一句回顾', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF 与 FC' }, { text: '(2) 求线段 BE' }]), ask('DF 是多少？')] },
      { calls: [judge('right', '对'), PLAN([{ text: '(1) 求 DF 与 FC', done: true }, { text: '(2) 求线段 BE' }]), draw(), zoomTo(), ask('BE 呢？')] },
      {
        calls: [
          judge('right', '也对'),
          PLAN([{ text: '(1) 求 DF 与 FC', done: true }, { text: '(2) 求线段 BE', done: true }]),
          call('canvas_create', { shapes: [{ type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] }] }),
          call('canvas_create', { shapes: [{ type: 'line', x: 5, y: 5, points: [[0, 0], [10, 10]] }] }),
        ],
      },
      { calls: [call('tutor_finish', { summary: '你自己走通了折叠→勾股这条路' })] },
      { text: '' },
    ]);
    await speak(h, '给我讲这道题');

    expect(h.session.mode).toBe('assist');
    expect(h.session.tutor).toBeNull();

    const modes = h.events('session.mode');
    expect(modes.at(-1)!.mode).toBe('assist');
    expect(modes.at(-1)!.note).toContain('这次辅导到此结束');
    expect(modes.at(-1)!.note).toContain('2 个小问');

    expect(h.events('agent.todo').at(-1)!.items).toEqual([]);
    expect(h.events('agent.say').at(-1)!.text).toContain('折叠');
  });

  it('讲完了会撒花，带上他自己做出来几问', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('DF?')] },
      { calls: [judge('right', '对'), PLAN([{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE' }]), draw(), zoomTo(), ask('BE?')] },
      {
        calls: [
          judge('right', '也对'),
          PLAN([{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE', done: true }]),
          call('canvas_create', { shapes: [{ type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] }] }),
          call('canvas_create', { shapes: [{ type: 'line', x: 5, y: 5, points: [[0, 0], [10, 10]] }] }),
        ],
      },
      { calls: [call('tutor_finish', { summary: '走通了' })] },
      { text: '' },
    ]);
    await speak(h, '给我讲这道题');

    const cheer = h.events('agent.celebrate');
    expect(cheer).toHaveLength(1);
    expect(cheer[0]!.solved).toBe(2);
  });

  it('账没平被拒的那次不撒花——见者有份就不值钱了', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }])] },
      { calls: [call('tutor_finish', { summary: '讲完了' })] },
      { calls: [ask('那 (2) 呢？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    expect(h.events('agent.celebrate')).toHaveLength(0);
  });
});

/**
 * 真机反馈分两轮才摸到这条真正的门槛。第一轮全程零画，"基本都是
 * chat"，加了"至少画一笔"；第二轮卡着底线交差——一整场三问的辅导
 * 从头到尾只画了一笔，用户吐槽"太敷衍了"，让参照老师上课的板书：
 * 讲一步写一步，不是全程讲完最后补一笔意思意思。门槛因此改成
 * 数量要跟小问个数大致匹配，不是"画过没有"这种有无判断。
 */
describe('画得不够多——不许收尾', () => {
  it('全程只高亮、一笔没画 → tutor_finish 被拒', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }]), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('x 是多少？')] },
        { calls: [judge('right', '对'), PLAN([{ text: '(1) 求 x', done: true }])] },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { calls: [call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('还有问题吗？')] },
        { text: '没了' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    // 每个工具会先发一条 running 再发终态，取最后一条
    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('error');
    expect(finish.call.error).toContain('一大片空白');
    // 第一次被拒之后，模式还没被放走
    expect(h.session.mode).toBe('tutor');
  });

  it('一问的题只画了一笔——门槛是至少两笔，还是被拒', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }]), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('x 是多少？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }]),
            call('canvas_create', { shapes: [{ type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] }] }),
          ],
        },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { calls: [call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('还有问题吗？')] },
        { text: '没了' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('error');
    expect(h.session.mode).toBe('tutor');
  });

  /**
   * 真机反馈过：按小问个数算门槛，低估了一场辅导实际讲了多少内容——
   * 一道题拆成 4 个小问，但问答了 8 轮才走完，画布上却只画了两笔，
   * 用户对着录像问"中间有很多空白区域，为什么不做板书"。小问个数是
   * 拆题时定的静态值，跟到底问答了几轮是两回事：同一个小问可能三言
   * 两语带过，也可能来回追问四五轮才吃透。当时的药方是把门槛换成
   * askedQuestions.length（问答了几轮），不再看小问个数。
   *
   * 后来 drawnSinceJudge 这道闸上线（每判完一轮、下一次提问前必须先
   * 落一笔），这条旧门槛反而被架空了：判过的每一轮都保证至少有一笔，
   * 5 轮问答画布上至少留 4 笔，而这里的门槛只要求 3 笔
   * （askedQuestions.length − 2）。"问答了很多轮却画得很少"这种
   * 场景，现在在正常流程里已经走不出来了——不是这条门槛失效，是它
   * 拦的那类漏洞从源头就被堵住了。这条用例因此改成验证这一点：
   * 5 轮问答、每轮之间都规规矩矩落了一笔，收尾自然放行。
   */
  it('小问不多但问答了很多轮——drawnSinceJudge 保证了每轮都落笔，收尾放行', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }, { text: '(2) 求 y' }]), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('第一步该怎么想？')] },
        { calls: [judge('right', '对'), draw(), zoomTo(), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('列出方程？')] },
        { calls: [judge('right', '对'), draw(), zoomTo(), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('解出 x 是多少？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }, { text: '(2) 求 y' }]),
            call('canvas_create', { shapes: [{ type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] }] }),
            zoomTo(),
            call('canvas_highlight', { ids: ['sh_a'], ms: 0 }),
            ask('接下来第二步怎么想？'),
          ],
        },
        { calls: [judge('right', '对'), draw(), zoomTo(), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('代入求出 y？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }, { text: '(2) 求 y', done: true }]),
            call('canvas_create', { shapes: [{ type: 'line', x: 5, y: 5, points: [[0, 0], [10, 10]] }] }),
          ],
        },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { text: '好' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    // 5 轮问答、每轮判完都落了一笔——总笔数早就过了门槛
    expect(h.events('agent.ask')).toHaveLength(5);
    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('ok');
    expect(h.session.mode).toBe('assist');
  });

  it('画够了（两笔）→ 放行', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }]), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('x 是多少？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }]),
            call('canvas_create', { shapes: [{ type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] }] }),
            call('canvas_create', { shapes: [{ type: 'line', x: 5, y: 5, points: [[0, 0], [10, 10]] }] }),
          ],
        },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { text: '好' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    // 每个工具会先发一条 running 再发终态，取最后一条
    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('ok');
    expect(h.session.mode).toBe('assist');
  });

  /**
   * 用户点破的盲区："我指的板书是 canva 上画图案，而不是 chat"。
   * 门槛数字凑够了，但画布上全是 text 图元（公式一条条拆开写），
   * 一个真正的图形都没有——这跟聊天框里打字对用户来说没什么区别。
   */
  it('画够了两笔，但全是 text 图元——没有一笔是真图案，还是被拒', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }]), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('x 是多少？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }]),
            call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 200, text: 'x = 1' }] }),
            call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 260, text: 'y = 2' }] }),
          ],
        },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { text: '好' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('error');
    expect(finish.call.error).toContain('全是文字');
    expect(h.session.mode).toBe('tutor');
  });

  it('两笔里哪怕只有一笔是真图案（line）——放行', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }]), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('x 是多少？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }]),
            call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 200, text: 'x = 1' }] }),
            call('canvas_create', { shapes: [{ type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] }] }),
          ],
        },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { text: '好' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('ok');
    expect(h.session.mode).toBe('assist');
  });

  /**
   * 真机复现过卡死：一道纯符号推导的题，模型始终画不出一个真图案，
   * "全是文字"这道闸每次都拒，模型开始把同一批总结话术颠来倒去
   * 重复，十分钟没有任何新进展。闸不能死磕到底——连着卡够次数就得
   * 放行，把"至少一笔图案"从硬性要求退成"尽量做到"，不能让"讲得
   * 好不好"的问题变成"能不能讲完"的问题。
   */
  it('全是文字连着拒了两次——第三次放行，不会卡死', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }]), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('x 是多少？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }]),
            call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 200, text: 'x = 1' }] }),
            call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 260, text: 'y = 2' }] }),
          ],
        },
        // 第一次被拒——只统计一笔 graphicsBlockCount，模式还没被放走
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        // 第二次还是被拒——文字始终没变成图案
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        // 第三次：闸放行，不再要求"至少一笔图案"
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { text: '好' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    const finishes = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish' && m.call.state !== 'running');
    expect(finishes).toHaveLength(3);
    expect(finishes[0]!.call.state).toBe('error');
    expect(finishes[0]!.call.error).toContain('全是文字');
    expect(finishes[1]!.call.state).toBe('error');
    expect(finishes[2]!.call.state).toBe('ok');
    expect(h.session.mode).toBe('assist');
  });

  /**
   * 真机录像复现过"确实在补，但补不满"：一道 4 问的微分方程，门槛
   * 算出来要至少 6 笔，模型认真回应了这道闸、一次次重试之间画布上
   * 的笔数从 0 加到 1、2、3——不是敷衍，但补到第 3 笔就没了后劲，
   * 连着几次只重复"我需要补充板书"却不再真的落笔，最后卡到录像
   * 脚本自己的空闲超时才收场，tutor_finish 全程一次都没通过。
   */
  it('画得不够多——连着拒了三次，第四次放行，不会卡死', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }]), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('x 是多少？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }]),
            // 只画一笔真图案——drawCount=1，graphicalDrawCount=1，
            // 但需要的至少 2 笔（needDraws 的下限）没凑够
            call('canvas_create', { shapes: [{ type: 'line', x: 0, y: 0, points: [[0, 0], [10, 10]] }] }),
          ],
        },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { text: '好' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    const finishes = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish' && m.call.state !== 'running');
    expect(finishes).toHaveLength(4);
    expect(finishes[0]!.call.state).toBe('error');
    expect(finishes[0]!.call.error).toContain('一大片空白');
    expect(finishes[1]!.call.state).toBe('error');
    expect(finishes[2]!.call.state).toBe('error');
    expect(finishes[3]!.call.state).toBe('ok');
    expect(h.session.mode).toBe('assist');
  });
});

/**
 * 用户在真实画布里点开一场几何题演练才看出来的盲区："图和字完全是
 * 两个世界"——题目自带一个三角形矢量图，问答判定全对，画布上也确实
 * 有一个非文字图元（给最后一行文字结果画的方框），但从头到尾没碰过
 * 那个三角形一下。"有没有图案"这道闸对这种情况没用——得换成"这笔
 * 图案挨着题目自带的图形吗"。
 */
describe('题目自带图形——板书里的图案得挨着它，不能各画各的', () => {
  it('图案画在离题目图形老远的地方——被拒', async () => {
    const scene = new Scene();
    scene.create([{ type: 'line', id: 'sh_tri', x: 0, y: 0, points: [[0, 0], [100, 100]] }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }]), call('canvas_highlight', { ids: ['sh_tri'], ms: 0 }), ask('x 是多少？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }]),
            call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 300, text: 'x = 1' }] }),
            // 图案本身是真图形（line），但离题目那条线足有 900 像素远，没沾边
            call('canvas_create', { shapes: [{ type: 'line', points: [[1000, 1000], [1010, 1010]] }] }),
          ],
        },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { text: '好' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('error');
    expect(finish.call.error).toContain('没有一笔挨着它');
    expect(h.session.mode).toBe('tutor');
  });

  it('图案挨着题目自带的图形——放行', async () => {
    const scene = new Scene();
    scene.create([{ type: 'line', id: 'sh_tri', x: 0, y: 0, points: [[0, 0], [100, 100]] }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }]), call('canvas_highlight', { ids: ['sh_tri'], ms: 0 }), ask('x 是多少？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }]),
            call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 300, text: 'x = 1' }] }),
            // 就画在题目那条线的包围盒里面——真的碰过它
            call('canvas_create', { shapes: [{ type: 'line', points: [[10, 10], [30, 30]] }] }),
          ],
        },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { text: '好' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('ok');
    expect(h.session.mode).toBe('assist');
  });

  /**
   * 跟 graphicsBlockCount 一样，不能死磕到底——连着卡够次数就放行，
   * 不能让"图画得像不像那么回事"变成"这场辅导能不能收尾"的生死问题。
   */
  it('连着拒了两次——第三次放行，不会卡死', async () => {
    const scene = new Scene();
    scene.create([{ type: 'line', id: 'sh_tri', x: 0, y: 0, points: [[0, 0], [100, 100]] }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 x' }]), call('canvas_highlight', { ids: ['sh_tri'], ms: 0 }), ask('x 是多少？')] },
        {
          calls: [
            judge('right', '对'),
            PLAN([{ text: '(1) 求 x', done: true }]),
            call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 300, text: 'x = 1' }] }),
            call('canvas_create', { shapes: [{ type: 'line', points: [[1000, 1000], [1010, 1010]] }] }),
          ],
        },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { calls: [call('tutor_finish', { summary: '讲完了' })] },
        { text: '好' },
      ],
      { scene, autoAnswer: '1' },
    );
    await speak(h, '给我讲这道题');

    const finishes = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish' && m.call.state !== 'running');
    expect(finishes).toHaveLength(3);
    expect(finishes[0]!.call.state).toBe('error');
    expect(finishes[0]!.call.error).toContain('没有一笔挨着它');
    expect(finishes[1]!.call.state).toBe('error');
    expect(finishes[2]!.call.state).toBe('ok');
    expect(h.session.mode).toBe('assist');
  });
});

describe('打勾要有门票', () => {
  it('用户一个字没答就想打勾 → 撤回', async () => {
    const h = tutor([
      // 实测模型真会这么干：用户一个字还没答，第 (1) 问就已经打上勾了
      { calls: [PLAN([{ text: '(1) 求 DF 与 FC', done: true }, { text: '(2) 求 BE' }]), ask('DF 怎么来的？')] },
      { text: '嗯' },
    ]);
    await speak(h, '给我讲这道题');

    expect(h.session.tutor?.outline).toEqual([
      { text: '(1) 求 DF 与 FC', done: false },
      { text: '(2) 求 BE', done: false },
    ]);
  });

  it('连调两次 tutor_plan 也绕不过去——实测模型就是这么钻空子的', async () => {
    const h = tutor([
      {
        calls: [
          PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]),
          PLAN([{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE' }]),
          ask('DF 是多少？'),
        ],
      },
      { calls: [judge('right', '对')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    // 那次打勾发生在用户回答之前，不算数
    expect(h.session.tutor?.outline[0]!.done).toBe(false);
  });

  it('他答对了、判了 right，这一勾才打得上', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('DF 是多少？')] },
      { calls: [judge('right', '对，12'), PLAN([{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE' }])] },
      { calls: [ask('那 (2) 呢？')] },
      { text: '嗯' },
    ]);
    await speak(h, '给我讲这道题');

    expect(h.session.tutor?.outline[0]!.done).toBe(true);
  });

  it('判成 partly 换不来门票——那一步还没走通', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }]), ask('DF 是多少？')] },
      { calls: [judge('partly', '方向对，算错了一步'), PLAN([{ text: '(1) 求 DF', done: true }])] },
      { calls: [ask('再算一遍？')] },
      { text: '嗯' },
    ]);
    await speak(h, '给我讲这道题');

    expect(h.session.tutor?.outline[0]!.done).toBe(false);
  });

  it('一张门票只够打一个勾', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('DF 是多少？')] },
      { calls: [judge('right', '对')] },
      { calls: [PLAN([{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE' }])] },
      // 又想接着把 (2) 也打上，可他还没答过 (2)
      { calls: [PLAN([{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE', done: true }])] },
      { calls: [ask('那 (2) 呢？')] },
      { text: '嗯' },
    ]);
    await speak(h, '给我讲这道题');

    expect(h.session.tutor?.outline).toEqual([
      { text: '(1) 求 DF', done: true },
      { text: '(2) 求 BE', done: false },
    ]);
  });
});

describe('重发清单不会抹掉已完成的', () => {
  it('模型漏标 done 时，旧的打勾保留下来', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('DF 是多少？')] },
      { calls: [judge('right', '对'), PLAN([{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE' }])] },
      // 再次重发时把 (1) 的 done 漏了——真实模型会犯这个错
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('(2) 里 EC 是多少？')] },
      { calls: [judge('right', '对')] },
      { text: '嗯' },
    ]);
    await speak(h, '给我讲这道题');

    expect(h.session.tutor?.outline[0]).toEqual({ text: '(1) 求 DF', done: true });
  });
});

describe('每一轮都要把球交回给用户', () => {
  it('账没平又没提问 → 系统拦回来，模型有第二次机会', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }])] },
      { calls: [PLAN([{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE' }])] },
      // 不提问就想结束这一轮
      { text: '那这道题就讲完了。' },
      // 被拦回来之后补上提问
      { calls: [ask('(2) 里，BE 设成 x 的话 EC 是多少？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const nudge = h.loop
      .getHistory()
      .find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('球断在这里'));
    expect(nudge).toBeDefined();
    expect(String(nudge!.content)).toContain('(2) 求 BE');
    expect(h.events('agent.ask')).toHaveLength(1);
  });

  it('问过也不算数：他答完之后又没下文，一样拦', async () => {
    // interact_ask_user 会阻塞回合，所以走到这里时"问过"= 他早就答完了。
    // 这正是最常见的断球方式，不能因为这一轮问过就放行。
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }]), ask('AB 翻折过去变成哪条边？')] },
      { calls: [judge('right', '对')] },
      { text: '等你回答。' }, // 判完就没了，问题也不提
      { calls: [draw(), zoomTo(), ask('那 DF 呢？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const nudged = h.loop
      .getHistory()
      .some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('球断在这里'));
    expect(nudged).toBe(true);
    expect(h.events('agent.ask')).toHaveLength(2);
  });

  it('两条路各自限次，不会两边空转到步数上限', async () => {
    const h = tutor([
      // 第一步拆完题却没问——现在这一步本身就会被拉回来一次
      // （tutorHandBack() 不再只在"零工具调用"时才检查，见 loop.ts 的 handbackNudges）
      { calls: [PLAN([{ text: '(1) 求 DF' }])] },
      { text: '讲完了。' },
      { text: '真的讲完了。' }, // 还是不提问——这条路自己的提醒已经用掉了，到这里放行
    ]);
    await speak(h, '给我讲这道题');

    const nudges = h.loop
      .getHistory()
      .filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[系统] 这一轮你没有向用户提问'));
    // 两条路各碰一次：调了工具但没问（handbackNudges）+ 零工具调用（nudged），
    // 各自限次，不会无限提醒下去——第三步照样收工，总的模型调用次数不变
    expect(nudges).toHaveLength(2);
    expect(h.model.callCount).toBe(3);
  });

  it('清单空着就催拆题，而不是催提问', async () => {
    const h = tutor([
      { calls: [say('这道题我看明白了')] },
      { text: '' },
      { calls: [PLAN([{ text: '(1) 求 DF' }]), ask('第一步呢？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const nudge = h.loop
      .getHistory()
      .find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('你还没拆题'));
    expect(nudge).toBeDefined();
  });
});

describe('他答完，必须先说对不对', () => {
  /**
   * 只被一路追问、从不知道自己刚才那步是对是错，答十道题也没长进。
   * 所以做成硬约束：手上压着一次没判定的回答，就不许问下一个。
   */
  it('没判定就问下一个 → interact_ask_user 被拒', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('AF 等于哪条边？')] },
      // 他答了，这里却直接问下一个
      { calls: [ask('那 DF 呢？')] },
      { calls: [judge('right', '对，翻折后 AF=AB'), draw(), zoomTo(), ask('那 DF 呢？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const rejected = h
      .events('agent.tool')
      .filter((m) => m.call.name === 'interact_ask_user' && m.call.state === 'error');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.call.error).toContain('你还没说这答案对不对');
  });

  /**
   * 真实事故复现：H7 那场老师在学生答完之后没调 tutor_judge，
   * 而是直接调了 interact_say 说"这次先停在这里"就把回合结束了——
   * 一次判定都没给。原因是硬拦（execAskUser 那道闸）只挡了 interact_ask_user，
   * 模型换一个工具（interact_say、canvas_highlight 都行）就绕过去了。
   */
  it('用别的工具（不是问下一个）绕过判定，照样要被拉回来', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('AF 等于哪条边？')] },
      // 他答了，模型不判定，直接调 interact_say 想蒙混过去——
      // 这一步 out.calls.length > 0，旧逻辑的 tutorHandBack 压根不会被检查到
      { calls: [say('好，我们先到这里。')] },
      { calls: [judge('right', '对，AF=AB'), draw(), zoomTo(), ask('那 DF 呢？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const nudge = h.loop
      .getHistory()
      .find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('你到现在也没说这答案对不对'));
    expect(nudge).toBeDefined();

    // 最要紧的：真的被逼着判了，不是嘴上提醒完照样漏过去
    expect(h.events('agent.judge')).toHaveLength(1);
  });

  /**
   * 真机复现的第二种形状（和上面那条根子相同，症状不同）：判定给了，
   * 但没问下一步就直接 interact_say 宣布"这次先停在这里"——账上明明还有
   * 小问没解决，模型却当场决定收摊。这条也曾经绕得过去，因为
   * tutorHandBack() 只在零工具调用时才会被检查，而 interact_say 本身
   * 是"调了工具"。
   */
  it('判完就想收摊、没问下一步，照样要被拉回来', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('AF 等于哪条边？')] },
      // 判定给了，但没问下一步——直接想暂停，账上还有两个小问没解决
      { calls: [judge('right', '对，AF=AB'), say('好，我们先到这里。')] },
      // 我的修复应该把它拉回来，逼它继续问
      { calls: [draw(), zoomTo(), ask('那 DF 呢？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const nudge = h.loop
      .getHistory()
      .find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('球断在这里了'));
    expect(nudge).toBeDefined();

    // 最要紧的：真的又问了下一步，不是嘴上提醒完照样撒手不管
    expect(h.events('agent.ask')).toHaveLength(2);
  });

  /**
   * 真机复现的第三种形状，和上面两条根子不同：这次不是模型绕开判定，
   * 是**画画本身把等待中的提问打断了**。
   *
   * 老师问"你能画出这个三角形吗"，学生先画（kind:'draw' 事件），
   * push() 早先把它当成"新输入"直接 abort 了当前 turn——onAbort 清空
   * pendingAsk 但不设置 t.pending，随后学生补的文字答案也只是个普通
   * text 事件，从没被记成"待判定的回答"。模型接着调 tutor_judge，
   * 被拦下：账上查无此事。学生明明答了，系统却不知道。
   */
  it('学生先画图再补文字答案，画的动作不能把提问打断', async () => {
    const h = makeHarness([
      { calls: [PLAN([{ text: '(1) 画出三角形' }]), ask('你能画出这个直角三角形吗？')] },
      { calls: [judge('right', '对，画得对'), draw(), zoomTo(), ask('那斜边呢？')] },
      { text: '好' },
    ]);
    h.loop.push({ kind: 'text', text: '给我讲这道题', at: Date.now() });
    const draining = h.loop.drain();

    // 等 ask 真的挂上，再让"学生"先画一笔——这是复现的关键顺序
    for (let i = 0; i < 20 && h.events('agent.ask').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.events('agent.ask')).toHaveLength(1);
    const before = h.model.callCount;
    h.loop.push({ kind: 'draw', shapeIds: ['sh_tri'], region: [0, 0, 100, 100], at: Date.now() });

    // 画画不该触发新一轮模型调用——提问还在等，没被打断
    await new Promise((r) => setTimeout(r, 0));
    expect(h.model.callCount).toBe(before);

    // 学生这才把文字答案发过来，提问正常被回答
    h.loop.push({ kind: 'answer', askId: h.events('agent.ask')[0]!.askId, answer: '画好了，直角三角形', at: Date.now() });

    // 判定紧接着问了第二问（脚本第 2 步），把它也答掉，让这一轮正常收尾
    for (let i = 0; i < 20 && h.events('agent.ask').length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    h.loop.push({ kind: 'answer', askId: h.events('agent.ask')[1]!.askId, answer: '5', at: Date.now() });
    await draining;

    // 最要紧的：判定真的发生了，没有被"没有待判定的回答"拦下
    expect(h.events('agent.judge')).toHaveLength(1);
    const guardRejected = h
      .events('agent.tool')
      .some((m) => m.call.name === 'tutor_judge' && m.call.state === 'error');
    expect(guardRejected).toBe(false);
  });

  it('有人答了就通知各端把提问卡收掉——多开一个客户端不该对着旧问题发呆', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }]), ask('DF 是多少？')] },
      { calls: [judge('right', '对')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const asked = h.events('agent.ask');
    const done = h.events('agent.ask.done');
    expect(done).toHaveLength(1);
    expect(done[0]!.askId).toBe(asked[0]!.askId);
  });

  it('判定会发给用户，带上对错和理由', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }]), ask('AF 等于哪条边？')] },
      { calls: [judge('right', '对，翻折前后 AB 和 AF 重合')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const j = h.events('agent.judge');
    expect(j).toHaveLength(1);
    expect(j[0]!.verdict).toBe('right');
    expect(j[0]!.comment).toContain('重合');
    expect(h.session.tutor?.pending).toBeNull();
  });

  it('判完就能接着问', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }]), ask('AF 等于哪条边？')] },
      { calls: [judge('partly', '方向对，但 AF 对应的是 AB 不是 AD'), draw(), zoomTo(), ask('那再看看 AD？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const errs = h
      .events('agent.tool')
      .filter((m) => m.call.name === 'interact_ask_user' && m.call.state === 'error');
    expect(errs).toHaveLength(0);
    expect(h.events('agent.ask')).toHaveLength(2);
  });

  it('答了却一声不吭就收工 → 系统拦回来', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }]), ask('AF 等于哪条边？')] },
      { text: '嗯，那我们继续。' }, // 没判定就想结束这一轮
      { calls: [judge('right', '对')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const nudge = h.loop
      .getHistory()
      .find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('也没说这答案对不对'));
    expect(nudge).toBeDefined();
    expect(h.events('agent.judge')).toHaveLength(1);
  });

  it('最后一次回答没判定就想收尾 → tutor_finish 被拒', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }])] },
      { calls: [PLAN([{ text: '(1) 求 DF', done: true }]), ask('DF 是多少？')] },
      { calls: [call('tutor_finish', { summary: '讲完了' })] },
      { calls: [judge('right', '对，12')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const finish = h.events('agent.tool').filter((m) => m.call.name === 'tutor_finish').at(-1)!;
    expect(finish.call.state).toBe('error');
    expect(finish.call.error).toContain('还没给判定');
    expect(h.session.mode).toBe('tutor');
  });

  it('没人答过就判定 → 报错，不会凭空发一条判定给用户', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }]), judge('right', '很好')] },
      { calls: [ask('DF 是多少？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const j = h.events('agent.tool').filter((m) => m.call.name === 'tutor_judge').at(-1)!;
    expect(j.call.state).toBe('error');
    expect(h.events('agent.judge')).toHaveLength(0);
  });

  it('普通模式不受影响：提问不需要先判定', async () => {
    const h = makeHarness(
      [{ calls: [ask('圆角还是直角？')] }, { calls: [ask('多大半径？')] }, { text: '好' }],
      { autoAnswer: '圆角' },
    );
    await speak(h, '帮我把这几个节点连起来');

    const errs = h
      .events('agent.tool')
      .filter((m) => m.call.name === 'interact_ask_user' && m.call.state === 'error');
    expect(errs).toHaveLength(0);
  });
});

describe('用户自己要走的时候', () => {
  it('半路走人不撒花', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('第一步？')] },
      { calls: [judge('right', '对')] },
      { text: '嗯' },
      { text: '行。' },
    ]);
    await speak(h, '给我讲这道题');
    await speak(h, '先不学了，帮我画个流程图');

    expect(h.events('agent.celebrate')).toHaveLength(0);
  });

  it('说「直接告诉我答案」→ 退出辅导，销账', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('第一步？')] },
      { text: '嗯' },
      { text: '好，那我直接讲。' },
    ]);
    await speak(h, '给我讲这道题');
    await speak(h, '直接告诉我答案');

    expect(h.session.mode).toBe('assist');
    expect(h.session.tutor).toBeNull();
    expect(h.events('session.mode').at(-1)!.note).toContain('直接给你结果');
  });

  it('说「先不学了，帮我画个流程图」→ 退出辅导，并说清还剩几问', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('第一步？')] },
      { calls: [judge('right', '对'), PLAN([{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE' }]), ask('第二步？')] },
      { calls: [judge('partly', '差一点')] },
      { text: '嗯' },
      { text: '行，那我们画图。' },
    ]);
    await speak(h, '给我讲这道题');
    await speak(h, '先不学了，帮我画个流程图');

    expect(h.session.mode).toBe('assist');
    const note = h.events('session.mode').at(-1)!.note!;
    expect(note).toContain('还剩 1 个小问');
    expect(h.events('agent.todo').at(-1)!.items).toEqual([]);
  });
});

describe('用户想走的那句话打在答题框里', () => {
  /**
   * 辅导模式下 Agent 大部分时间停在 interact_ask_user 上，
   * 所以"先不学了"最可能出现的位置就是答题框，而不是聊天框。
   * 早先这条路径直接把答案塞给等待中的 ask，意图判断整个被跳过。
   */
  it('回答里说「先不学了」→ 照样退出辅导', async () => {
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }]), ask('DF 是多少？')] },
        { text: '行，那我们做别的。' },
      ],
      { autoAnswer: '先不学了，帮我画个流程图' },
    );
    await speak(h, '给我讲这道题');

    expect(h.session.mode).toBe('assist');
    expect(h.session.tutor).toBeNull();
    expect(h.events('session.mode').at(-1)!.note).toContain('还剩 2 个小问');
  });

  it('回答里说「直接告诉我答案」→ 照样退出辅导', async () => {
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 DF' }]), ask('DF 是多少？')] },
        { text: '好，那我直接讲。' },
      ],
      { autoAnswer: '别问了，直接告诉我答案' },
    );
    await speak(h, '给我讲这道题');

    expect(h.session.mode).toBe('assist');
    expect(h.events('session.mode').at(-1)!.note).toContain('直接给你结果');
  });

  it('回答「我不会」不会把人拖进辅导——那是在答题，不是在切模式', async () => {
    const h = makeHarness(
      [{ calls: [ask('这个角要圆角还是直角？')] }, { text: '好的' }],
      { autoAnswer: '我不会' },
    );
    await speak(h, '帮我把这几个节点连起来');

    expect(h.session.mode).toBe('assist');
    expect(h.session.tutor).toBeNull();
  });
});

describe('停手要明说', () => {
  /**
   * 题没讲完就停下来是允许的（超时、报错、模型自己不问了），
   * 不允许的是一声不吭地停：用户等在那里，不知道该答什么，也不知道是不是结束了。
   */
  it('模型自己不问了 → 兜底说清停在哪一问', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }])] },
      { text: '先到这儿。' }, // 被拦一次
      { text: '还是到这儿。' }, // 拦不动了，回合就此结束
    ]);
    await speak(h, '给我讲这道题');

    const said = h.events('agent.say').at(-1)!;
    expect(said.text).toContain('这次辅导先停在这里');
    expect(said.text).toContain('(1) 求 DF');
    expect(h.session.mode).toBe('tutor'); // 停下不等于退出，随时能接着学
  });

  it('还没拆题就停 → 也说一声', async () => {
    const h = tutor([{ text: '嗯。' }, { text: '嗯。' }]);
    await speak(h, '给我讲这道题');

    expect(h.events('agent.say').at(-1)!.text).toContain('还没开始拆');
  });

  it('问题还挂在他屏幕上、回合被打断时不插话', async () => {
    // 不自动作答：回合会一直阻塞在 interact_ask_user 上
    const h = makeHarness([{ calls: [PLAN([{ text: '(1) 求 DF' }]), ask('DF 是多少？')] }, { text: '好' }], {
      session: { mode: 'tutor', tutor: { goal: '讲这题', outline: [], startedTurn: 0, pending: null, rightSince: 0, markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0, attempts: [], concepts: [] } },
    });

    const running = speak(h, '继续');
    await new Promise((r) => setTimeout(r, 30));
    h.loop.abort(); // 相当于用户中途做了别的
    await running;

    const paused = h.events('agent.say').filter((m) => m.text.includes('先停在这里'));
    expect(paused).toHaveLength(0);
  });

  it('普通模式下不说这句话', async () => {
    const h = makeHarness([{ text: '画好了。' }]);
    await speak(h, '帮我画个方块');

    expect(h.events('agent.say')).toHaveLength(0);
  });
});

describe('等用户思考的时间不占回合额度', () => {
  it('他想了很久再答，回合不会超时死掉', async () => {
    const h = makeHarness(
      [
        { calls: [PLAN([{ text: '(1) 求 DF' }]), ask('DF 是多少？')] },
        { calls: [judge('right', '对')] },
        { text: '好' },
      ],
      {
        session: { mode: 'tutor', tutor: { goal: '讲这题', outline: [], startedTurn: 0, pending: null, rightSince: 0, markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0, attempts: [], concepts: [] } },
        maxMs: 120,
        // 想的时间比整个回合额度还长——挂钟计时的话这里必死
        autoAnswerDelayMs: 260,
        autoAnswer: '12',
      },
    );
    await speak(h, '继续');

    expect(h.events('agent.judge')).toHaveLength(1);
    expect(h.events('error')).toHaveLength(0);
  });
});

describe('一整场辅导是一个回合，别被步数上限掐断', () => {
  it('用户每答一次，步数额度重新起算', async () => {
    // maxSteps=8（harness 默认）。这里编排 12 步，中间穿插两次回答——
    // 不重置的话第 9 步就被判成 max_steps，辅导正在兴头上被掐掉。
    const steps: Array<{ text?: string; calls?: ReturnType<typeof call>[] }> = [
      { calls: [PLAN([{ text: '(1) 求 DF' }, { text: '(2) 求 BE' }])] },
      { calls: [say('先看这个三角形')] },
      { calls: [say('注意 AF')] },
      { calls: [say('还有 AD')] },
      { calls: [ask('DF 是多少？')] },       // 第 5 步，用户在这里开口
      { calls: [judge('right', '对')] },
      { calls: [say('那来看第二问')] },
      { calls: [say('设 BE=x')] },
      { calls: [say('EC 就是 5−x')] },
      { calls: [draw(), zoomTo(), ask('那 x 呢？')] },          // 第 10 步，用户又开口
      { calls: [judge('right', '也对')] },
      { text: '好' },
    ];
    const h = tutor(steps);
    await speak(h, '给我讲这道题');

    expect(h.events('agent.judge')).toHaveLength(2);
    const cutoff = h.loop
      .getHistory()
      .some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('已达上限'));
    expect(cutoff).toBe(false);
  });

  it('他一句话不说的空转还是会被掐掉', async () => {
    const spin = Array.from({ length: 12 }, () => ({ calls: [say('嗯')] }));
    const h = tutor(spin);
    await speak(h, '给我讲这道题');

    const cutoff = h.loop
      .getHistory()
      .some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('已达上限'));
    expect(cutoff).toBe(true);
  });
});

describe('讲解要指着图说', () => {
  it('上一个问题之后没在图上指过东西 → 上下文里提醒它', () => {
    const header = buildContextHeader({
      scene: new Scene(),
      session: {
        selection: [],
        viewport: [0, 0, 1440, 900],
        zoom: 1,
        editMode: 'suggest',
        mode: 'tutor',
        tutor: { goal: '讲这题', outline: [{ text: 'a', done: false }], startedTurn: 1, pending: null, rightSince: 0, markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0, attempts: [], concepts: [] },
      },
      events: [],
      turnNo: 3,
    });
    expect(header).toContain('还没在图上指过任何东西');
    expect(header).toContain('canvas_highlight(ms:0)');
  });

  it('指过了就不再念叨', () => {
    const header = buildContextHeader({
      scene: new Scene(),
      session: {
        selection: [],
        viewport: [0, 0, 1440, 900],
        zoom: 1,
        editMode: 'suggest',
        mode: 'tutor',
        tutor: { goal: '讲这题', outline: [{ text: 'a', done: false }], startedTurn: 1, pending: null, rightSince: 0, markedSinceAsk: true, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0, attempts: [], concepts: [] },
      },
      events: [],
      turnNo: 3,
    });
    expect(header).not.toContain('还没在图上指过');
  });

  it('高亮一下就记上；他答完之后重新归零，下一个问题要重新指', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }])] },
      { calls: [call('canvas_highlight', { ids: ['sh_a'], ms: 0 })] },
      { calls: [ask('这条边多长？')] },
      { calls: [judge('right', '对')] },
      { text: '好' },
    ]);
    h.scene.create([{ type: 'line', id: 'sh_a', points: [[0, 0], [10, 10]] }], {
      author: { id: 'u1', kind: 'user' },
    });
    await speak(h, '给我讲这道题');

    // 他已经答过一轮，所以下一个问题需要重新指一次
    expect(h.session.tutor?.markedSinceAsk).toBe(false);
  });

  it('空数组是"把高亮清掉"，不是错误', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }]), call('canvas_highlight', { ids: [] })] },
      { calls: [ask('看这里？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const hl = h.events('agent.tool').filter((m) => m.call.name === 'canvas_highlight').at(-1)!;
    expect(hl.call.state).toBe('ok');
    expect(h.events('agent.highlight').at(-1)!.shapeIds).toEqual([]);
  });

  it('高亮到已经删掉的 id：报错说清该怎么办，而不是干瞪眼', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }]), call('canvas_highlight', { ids: ['sh_gone'], ms: 0 })] },
      { calls: [ask('看这里？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const hl = h.events('agent.tool').filter((m) => m.call.name === 'canvas_highlight').at(-1)!;
    expect(hl.call.state).toBe('error');
    expect(hl.call.error).toContain('sh_gone');
  });

  /**
   * 真机录像复现过：上面这条提醒原样摆在每一轮的上下文里，一场六问的
   * 辅导，模型只在第 1 问照做了，后面五问全程零指点——学生自己全答对，
   * 但"图文并茂"从第二问起就名存实亡。提示词劝不动的事，改成硬闸。
   */
  it('画布上有内容但没指过——提问被拒，不能捂着眼讲', async () => {
    const scene = new Scene();
    scene.create([{ type: 'line', id: 'sh_a', points: [[0, 0], [10, 10]] }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness([{ calls: [ask('这条边多长？')] }, { text: '好' }], {
      scene,
      session: {
        mode: 'tutor',
        tutor: {
          goal: '讲这题',
          outline: [{ text: '(1) 求 DF', done: false }],
          startedTurn: 0,
          pending: null,
          rightSince: 0,
          markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0,
          attempts: [],
          concepts: [],
        },
      },
    });

    await speak(h, '继续');

    expect(h.events('agent.ask')).toEqual([]);
    const askCall = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user').at(-1)!;
    expect(askCall.call.state).toBe('error');
  });

  it('指过了再问——放行', async () => {
    const scene = new Scene();
    scene.create([{ type: 'line', id: 'sh_a', points: [[0, 0], [10, 10]] }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness([{ calls: [ask('这条边多长？')] }, { text: '好' }], {
      scene,
      autoAnswer: '嗯',
      session: {
        mode: 'tutor',
        tutor: {
          goal: '讲这题',
          outline: [{ text: '(1) 求 DF', done: false }],
          startedTurn: 0,
          pending: null,
          rightSince: 0,
          markedSinceAsk: true, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0,
          attempts: [],
          concepts: [],
        },
      },
    });

    await speak(h, '继续');

    expect(h.events('agent.ask')).toHaveLength(1);
  });

  it('画布是空的——没什么可指，不拦', async () => {
    const h = makeHarness([{ calls: [ask('接下来怎么想？')] }, { text: '好' }], {
      autoAnswer: '嗯',
      session: {
        mode: 'tutor',
        tutor: {
          goal: '讲这题',
          outline: [{ text: '(1) 求极限', done: false }],
          startedTurn: 0,
          pending: null,
          rightSince: 0,
          markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0,
          attempts: [],
          concepts: [],
        },
      },
    });

    await speak(h, '继续');

    expect(h.events('agent.ask')).toHaveLength(1);
  });
});

/**
 * 用户直接要求"尽量做到每次对话都能在板书上留下内容"——跟上面
 * "讲解要指着图说"是同一类问题（提示词劝不动，改成硬闸），只是这次
 * 拦的不是"有没有指过"，是"判完这一轮，板书有没有跟上"。
 */
describe('判完这一题，板书得跟上——不然不许问下一题', () => {
  it('判完就想问下一题，中间没画板书——被拒', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 x' }]), ask('x 是多少？')] },
      { calls: [judge('right', '对'), ask('接下来呢？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user' && m.call.state !== 'running');
    expect(asks.at(-1)!.call.state).toBe('error');
    expect(asks.at(-1)!.call.error).toContain('推理过程还没写进板书区');
  });

  it('判完先画一笔再问——放行', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 x' }]), ask('x 是多少？')] },
      {
        calls: [
          judge('right', '对'),
          call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 200, text: 'x = 1' }] }),
          zoomTo(),
          ask('接下来呢？'),
        ],
      },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user' && m.call.state !== 'running');
    expect(asks.at(-1)!.call.state).toBe('ok');
  });

  it('辅导刚开始、一次判定都还没发生——第一个问题不会被误拦', async () => {
    const h = tutor([{ calls: [PLAN([{ text: '(1) 求 x' }]), ask('x 是多少？')] }, { text: '好' }]);
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user' && m.call.state !== 'running');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.call.state).toBe('ok');
  });

  /**
   * 真机复现过一场真正的死局：判完题之后连着被这道闸拦了三次，模型
   * 没能很快补上一笔，回合活活耗成空转超时收场——比"这一步没画"更糟。
   * 跟 drawBlockCount / graphicsBlockCount 一样，连着卡够次数就得放行。
   */
  it('连着拒了三次——第四次放行，不会卡死', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 x' }]), ask('x 是多少？')] },
      { calls: [judge('right', '对'), ask('接下来呢？')] },
      { calls: [ask('接下来呢？')] },
      { calls: [ask('接下来呢？')] },
      { calls: [ask('接下来呢？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user' && m.call.state !== 'running');
    expect(asks.filter((m) => m.call.state === 'error')).toHaveLength(3);
    expect(asks.at(-1)!.call.state).toBe('ok');
  });
});

/**
 * 用户看完板书截图后提的第三条反馈："画板书的时候，也可以控制当前
 * 视角到板书居中的位置"——跟上面 drawnSinceJudge 是同一类问题、
 * 同一种药方：提示词已经写了"写字的同时把镜头带过去"，真机验证过
 * 三场，canvas_zoom_to 一次都没被调用过。
 */
describe('画完板书，镜头得跟过去——不然不许问下一题', () => {
  it('画完就想问下一题，镜头没跟过去——被拒', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 x' }]), ask('x 是多少？')] },
      {
        calls: [
          judge('right', '对'),
          call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 200, text: 'x = 1' }] }),
          ask('接下来呢？'),
        ],
      },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user' && m.call.state !== 'running');
    expect(asks.at(-1)!.call.state).toBe('error');
    expect(asks.at(-1)!.call.error).toContain('镜头还没带过去');
  });

  it('画完带一次镜头再问——放行', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 x' }]), ask('x 是多少？')] },
      {
        calls: [
          judge('right', '对'),
          call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 200, text: 'x = 1' }] }),
          call('canvas_zoom_to', { region: [0, 180, 200, 60] }),
          ask('接下来呢？'),
        ],
      },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user' && m.call.state !== 'running');
    expect(asks.at(-1)!.call.state).toBe('ok');
  });

  it('辅导刚开始、还什么都没画过——第一个问题不会被误拦', async () => {
    const h = tutor([{ calls: [PLAN([{ text: '(1) 求 x' }]), ask('x 是多少？')] }, { text: '好' }]);
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user' && m.call.state !== 'running');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.call.state).toBe('ok');
  });

  /**
   * 跟 drawAskBlockCount 一样的道理，从一开始就留好退路——见
   * context.ts 里 zoomBlockCount 的注释。
   */
  it('连着拒了三次——第四次放行，不会卡死', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 x' }]), ask('x 是多少？')] },
      {
        calls: [
          judge('right', '对'),
          call('canvas_create', { shapes: [{ type: 'text', x: 0, y: 200, text: 'x = 1' }] }),
          ask('接下来呢？'),
        ],
      },
      { calls: [ask('接下来呢？')] },
      { calls: [ask('接下来呢？')] },
      { calls: [ask('接下来呢？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user' && m.call.state !== 'running');
    expect(asks.filter((m) => m.call.state === 'error')).toHaveLength(3);
    expect(asks.at(-1)!.call.state).toBe('ok');
  });
});

describe('账本每一轮都摆在模型眼前', () => {
  const base: SessionState = {
    selection: [],
    viewport: [0, 0, 1440, 900],
    zoom: 1,
    editMode: 'suggest',
    mode: 'tutor',
    tutor: null,
  };

  it('列出待办并点名下一个该攻的', () => {
    const header = buildContextHeader({
      scene: new Scene(),
      session: {
        ...base,
        tutor: {
          goal: '给我讲这道题',
          outline: [
            { text: '(1) 求 DF 与 FC 的长', done: true },
            { text: '(2) 求线段 BE 的长', done: false },
          ],
          startedTurn: 1,
          pending: null,
          rightSince: 0, markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0, attempts: [], concepts: []
        },
      },
      events: [],
      turnNo: 4,
    });

    expect(header).toContain('[辅导中] 用户要学会的是：给我讲这道题');
    expect(header).toContain('✓ (1) 求 DF 与 FC 的长');
    expect(header).toContain('▢ (2) 求线段 BE 的长');
    expect(header).toContain('这次辅导不能结束');
    expect(header).toContain('(2) 求线段 BE 的长」');
  });

  it('还没拆题时催拆题', () => {
    const header = buildContextHeader({
      scene: new Scene(),
      session: { ...base, tutor: { goal: '讲讲这题', outline: [], startedTurn: 1, pending: null, rightSince: 0, markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0, attempts: [], concepts: [] } },
      events: [],
      turnNo: 1,
    });
    expect(header).toContain('还没拆题');
  });

  /**
   * 真机复现过：模型没有主动去看画布上的题目原文，凭空编了一个题目
   * 往下讲，甚至把提示词里的拆题措辞示例当成了题目本身。题目原文
   * （role=statement）该直接摆在账本旁边，不等模型自觉去查。
   */
  it('画布上有题目原文（role=statement）——直接摆给模型，不用等它自己去查', () => {
    const scene = new Scene();
    scene.create(
      [{ type: 'text', id: 'sh_stmt', x: 0, y: 0, text: '求解 y″ − 3y′ + 2y = 2eˣ，y(0) = 0，y′(0) = 1。', meta: { role: 'statement' } }],
      { author: { id: 'seed', kind: 'user' } },
    );
    const header = buildContextHeader({
      scene,
      session: { ...base, tutor: { goal: '给我讲这道题', outline: [], startedTurn: 1, pending: null, rightSince: 0, markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0, attempts: [], concepts: [] } },
      events: [],
      turnNo: 1,
    });
    expect(header).toContain('[画布上的题目原文]');
    expect(header).toContain('y″ − 3y′ + 2y = 2eˣ');
  });

  /**
   * 真机复现过：题目自带一个三角形，模型想 canvas_highlight 讲到的
   * 那条边，却编了个"听起来该有"的 id（"triangle_ABC"）去调——画布上
   * 从来没有这个 id，一次次失败，最后反过来问学生"你能指出三角形的
   * 位置吗"。种题脚本给每个图元标了 role，但没把真实 id 报给模型，
   * 它只能猜。这条验证的是：题目图形的真实 id 和 role 得摆在账本旁边。
   */
  it('题目自带图形——把组成图形的真实 id 和 role 摆出来，不用它自己猜', () => {
    const scene = new Scene();
    scene.create(
      [
        { type: 'line', id: 'sh_ab', x: 0, y: 0, points: [[0, 0], [10, 10]], meta: { role: 'side-AB' } },
        { type: 'line', id: 'sh_altitude', x: 0, y: 0, points: [[5, 0], [5, 10]], meta: { role: 'altitude-AD' } },
        { type: 'text', id: 'sh_vertex_a', x: 0, y: 0, text: 'A', meta: { role: 'vertex' } },
      ],
      { author: { id: 'seed', kind: 'user' } },
    );
    const header = buildContextHeader({
      scene,
      session: {
        ...base,
        tutor: {
          goal: '给我讲这道题', outline: [], startedTurn: 1, pending: null, rightSince: 0, markedSinceAsk: false,
          drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0,
          drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0,
          askedQuestions: [], stuckStreak: 0, attempts: [], concepts: [],
        },
      },
      events: [],
      turnNo: 1,
    });
    expect(header).toContain('[题目上的图形图元]');
    expect(header).toContain('sh_ab(side-AB)');
    expect(header).toContain('sh_altitude(altitude-AD)');
    expect(header).toContain('sh_vertex_a(vertex,"A")');
  });

  it('不在辅导里就一个字都不加', () => {
    const header = buildContextHeader({
      scene: new Scene(),
      session: { ...base, mode: 'assist' },
      events: [],
      turnNo: 1,
    });
    expect(header).not.toContain('辅导');
  });
});

/**
 * 掌握度记录不能靠模型的自觉性。
 *
 * 实测 stealth/ox-alpha 整场辅导一次都没调 kg_lookup，于是七次判定
 * 一个知识点都没记上——"学生学到了什么"这条产品主线在那一整场里
 * 等于不存在，而且全程不报错。交给模型自觉去做的事，迟早有一天它不做。
 */
describe('知识点在拆题时就落地', () => {
  /**
   * mentions 是"哪些知识点的名字出现在这段话里"，方向和 search 相反。
   * 桩子按这个语义写：整句话里含「勾股」就算命中——真实实现扫的是
   * 一万多个节点名，这里只是把语义固定下来。
   */
  const kg = {
    search: (q: string) => (q === '勾股定理' ? [{ id: 'c_pyth', name: '勾股定理', label: '数学' }] : []),
    mentions: (text: string) =>
      text.includes('勾股') ? [{ id: 'c_pyth', name: '勾股定理', label: 'Concept' }] : [],
    prerequisites: () => [],
    record: async () => {},
  };

  it('拆题时用小问的文字反查，存进账本', async () => {
    const h = makeHarness([{ calls: [call('tutor_plan', { items: [{ text: '用勾股定理列方程', done: false }, { text: '解出 BD', done: false }] })] }], {
      session: { mode: 'tutor', tutor: { goal: 'Geometry — Triangle with an Altitude', outline: [], startedTurn: 0, pending: null, rightSince: 0, markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0, attempts: [], concepts: [] } },
      knowledge: kg,
    });
    h.loop.push({ kind: 'text', text: '继续', at: Date.now() });
    await h.loop.drain();

    expect(h.session.tutor!.concepts).toContain('c_pyth');
  });

  it('模型没带 conceptIds 时，判定用账本里那批兜底', async () => {
    const h = makeHarness(
      [
        { calls: [call('tutor_judge', { verdict: 'right', comment: '对' })] },
      ],
      {
        session: {
          mode: 'tutor',
          tutor: {
            goal: '讲这题',
            outline: [{ text: 'a', done: false }],
            startedTurn: 0,
            pending: { question: 'AD² 等于什么？', answer: '169 − x²' },
            rightSince: 0,
            markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0,
            attempts: [],
            concepts: ['c_pyth'],
          },
        },
        knowledge: kg,
      },
    );
    h.loop.push({ kind: 'text', text: '继续', at: Date.now() });
    await h.loop.drain();

    expect(h.session.tutor!.attempts).toEqual([{ conceptId: 'c_pyth', ok: true, guided: true }]);
  });

  it('模型给了 conceptIds 就听它的——它最清楚这一步考的是什么', async () => {
    const h = makeHarness(
      [{ calls: [call('tutor_judge', { verdict: 'right', comment: '对', conceptIds: ['c_specific'] })] }],
      {
        session: {
          mode: 'tutor',
          tutor: {
            goal: '讲这题',
            outline: [{ text: 'a', done: false }],
            startedTurn: 0,
            pending: { question: 'q', answer: 'a' },
            rightSince: 0,
            markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0,
            attempts: [],
            concepts: ['c_fallback'],
          },
        },
        knowledge: kg,
      },
    );
    h.loop.push({ kind: 'text', text: '继续', at: Date.now() });
    await h.loop.drain();

    expect(h.session.tutor!.attempts.map((a) => a.conceptId)).toEqual(['c_specific']);
  });
});

/**
 * 意图正则该是捷径，不是门闸。
 *
 * 三次演练栽在同一处：学生确实在求辅导，但那句话没被正则认出来
 * （"老师你一步步问我吧"——动词表里没有「问」）。模型判断对了、
 * 调了 tutor_plan，被闸拦下，于是整场辅导照讲，账本全空：
 * 不拆题、不判定、不记掌握度，而且不报错。
 */
describe('模型自己决定开始辅导', () => {
  it('没进辅导模式时调 tutor_plan，就地开始辅导', async () => {
    const h = makeHarness([{ calls: [call('tutor_plan', { items: [{ text: '第一问：求 BD', done: false }] })] }]);
    h.loop.push({ kind: 'text', text: '老师你一步步问我吧', at: Date.now() });
    await h.loop.drain();

    expect(h.session.mode).toBe('tutor');
    expect(h.session.tutor!.outline.map((i) => i.text)).toEqual(['第一问：求 BD']);
  });

  it('用户刚喊停就不能被拖回去——那是他明确说过不想要的', async () => {
    const h = makeHarness([{ calls: [call('tutor_plan', { items: [{ text: '第一问', done: false }] })] }], {
      session: { mode: 'assist', tutor: null, tutorJustExited: true },
    });
    h.loop.push({ kind: 'text', text: '继续', at: Date.now() });
    await h.loop.drain();

    expect(h.session.mode).toBe('assist');
    expect(h.session.tutor).toBeNull();
  });
});

/**
 * 半路走人，答对过的也要算数。
 *
 * 早先攒到 tutor_finish 才一次写入，中途退出全丢——理由是"他没走完"。
 * 但掌握度是**按知识点**记的，不是按题记的：他在勾股定理上连答对五步
 * 然后说"先不学了"，那五步是真的发生了。而过度记分的担心本来就不成立，
 * 辅导里全是 guided，封顶 0.55，够不着 0.6「基本掌握」。
 */
describe('中途退出时的落盘', () => {
  it('用户喊停，已经答对的那几步照样进图谱', async () => {
    const saved: Array<{ conceptId: string; ok: boolean }> = [];
    const h = makeHarness([{ text: '好的，那我直接说答案' }], {
      session: {
        mode: 'tutor',
        tutor: {
          goal: '讲这题',
          outline: [{ text: 'a', done: false }],
          startedTurn: 0,
          pending: null,
          rightSince: 0,
          markedSinceAsk: false, drawCount: 0, graphicalDrawCount: 0, graphicsBlockCount: 0, diagramBlockCount: 0, drawBlockCount: 0, drawnSinceJudge: true, drawAskBlockCount: 0, zoomedSinceDraw: true, zoomBlockCount: 0, askedQuestions: [], stuckStreak: 0,
          attempts: [
            { conceptId: 'c_pyth', ok: true, guided: true },
            { conceptId: 'c_tri', ok: false, guided: true },
          ],
          concepts: [],
        },
      },
      knowledge: {
        search: () => [],
        mentions: () => [],
        prerequisites: () => [],
        record: async (as) => {
          saved.push(...as);
        },
      },
    });

    h.loop.push({ kind: 'text', text: '先不学了，直接告诉我答案', at: Date.now() });
    await h.loop.drain();

    expect(h.session.mode).toBe('assist');
    expect(saved.map((a) => a.conceptId)).toEqual(['c_pyth', 'c_tri']);
  });
});

/**
 * 真机复现过：题目原文标了 (1)~(5) 五问，提示词里已经写了"编号要一一对应"，
 * 模型还是把它揉成 3 条"理解题目条件/分析图形结构/逐步求解"这种流程步骤，
 * 判完 3 条就收尾，(4)(5) 两问用户压根没被问起。
 * 提示词管不住这种事，改成硬闸：开局拆题条数比原文里的编号少，直接拒绝。
 */
describe('开局拆题不能比原文的编号少', () => {
  function amcScene() {
    const scene = new Scene();
    scene.create(
      [
        {
          type: 'text',
          x: 0,
          y: 0,
          text:
            '(1) Find BD and DC. (2) Find the length of the altitude AD. ' +
            '(3) Find the area of triangle ABC. (4) Find the radius r of the inscribed circle. ' +
            '(5) Find the radius R of the circumscribed circle.',
        },
      ],
      { author: { id: 'seed', kind: 'user' }, layer: 'user' },
    );
    return scene;
  }

  it('五问只拆三条——拒绝，没能开出一张缩水的账本', async () => {
    const scene = amcScene();
    const h = makeHarness(
      [{ calls: [PLAN([{ text: '理解题目条件' }, { text: '计算' }, { text: '验证结果' }])] }],
      { scene, autoAnswer: '嗯' },
    );
    await speak(h, '给我讲这道题');

    expect(h.session.tutor?.outline ?? []).toEqual([]);
  });

  it('五问拆足五条——放行', async () => {
    const scene = amcScene();
    const h = makeHarness(
      [
        {
          calls: [
            PLAN([
              { text: '(1) 求 BD 和 DC' },
              { text: '(2) 求高 AD' },
              { text: '(3) 求面积' },
              { text: '(4) 求内切圆半径 r' },
              { text: '(5) 求外接圆半径 R' },
            ]),
            ask('先算 BD 吧，用什么关系？'),
          ],
        },
      ],
      { scene, autoAnswer: '嗯' },
    );
    await speak(h, '给我讲这道题');

    expect(h.session.tutor?.outline.length).toBe(5);
  });

  /**
   * 真机录像复现过一次比"漏数"更糟的：数多了。一道三问的微分方程题，
   * 题干里带着初值条件 "y(0) = 0，y′(0) = 1"——"(0)" 跟在变量名后面，
   * 是函数记号，不是第 0 问。计数正则不分青红皂白见括号里带数字就数，
   * 数出了 4 个（0、1、2、3）。模型三条据实拆了（1）（2）（3），被这道闸
   * 拒为"少拆了一条"；凑够 4 条又混进"总结思路"这种空转条目，被另一道
   * 闸拒。两道闸互相掐着，tutor_plan 全程一次没成功过，账本永远是空的，
   * tutor_finish 自然也永远进不去，一整场辅导退化成反复重问已经答过的
   * 问题，直到演练脚本自己的空闲超时收场。
   */
  it('题干里的 y(0)、y′(0) 是函数记号，不是第 0 问——不能被计进小问数', async () => {
    const scene = new Scene();
    scene.create(
      [
        {
          type: 'text',
          x: 0,
          y: 0,
          text:
            '求解初值问题 y″ − 3y′ + 2y = 2eˣ，y(0) = 0，y′(0) = 1。\n' +
            '(1) 求齐次方程的通解；\n' +
            '(2) 注意右端 2eˣ 与齐次解的关系，给出特解的正确设法并求出特解；\n' +
            '(3) 由初始条件定出待定常数，写出满足初值的解。',
        },
      ],
      { author: { id: 'seed', kind: 'user' }, layer: 'user' },
    );
    const h = makeHarness(
      [
        {
          calls: [
            PLAN([
              { text: '(1) 求齐次方程的通解' },
              { text: '(2) 求特解' },
              { text: '(3) 由初始条件定出待定常数' },
            ]),
            ask('先求齐次方程的特征方程？'),
          ],
        },
      ],
      { scene, autoAnswer: '嗯' },
    );
    await speak(h, '给我讲这道题');

    expect(h.session.tutor?.outline.length).toBe(3);
  });
});

/**
 * 真机复现过：三问的题拆了四条，条数够了（3≥3），但混进去的第四条
 * 是"理解题目内容"——一个没有明确对错标准的条目。学生把题目复述对了、
 * 被判过好几次 right，这条却始终没法被标 done，会话卡在这儿反复重问
 * 同一句"题目要求什么"，讲了十几分钟一步都没往前挪。
 */
describe('拆出来的小问不能是空转的流程标签', () => {
  function u8Scene() {
    const scene = new Scene();
    scene.create(
      [
        {
          type: 'text',
          x: 0,
          y: 0,
          text:
            '求函数 f(x,y)=x²+y² 在约束条件 x+2y=5 下的最小值。' +
            '(1) 写出拉格朗日函数；(2) 求出 x、y；(3) 求最小值。',
        },
      ],
      { author: { id: 'seed', kind: 'user' }, layer: 'user' },
    );
    return scene;
  }

  it('条数够了，但混进"理解题目内容"——拒绝', async () => {
    const scene = u8Scene();
    const h = makeHarness(
      [
        {
          calls: [
            PLAN([
              { text: '理解题目内容' },
              { text: '(1) 写出拉格朗日函数' },
              { text: '(2) 求出 x、y' },
              { text: '(3) 求最小值' },
            ]),
          ],
        },
      ],
      { scene, autoAnswer: '嗯' },
    );
    await speak(h, '给我讲这道题');

    expect(h.session.tutor?.outline ?? []).toEqual([]);
  });

  it('每条都挂着具体要算的东西——放行', async () => {
    const scene = u8Scene();
    const h = makeHarness(
      [
        {
          calls: [
            PLAN([
              { text: '(1) 写出拉格朗日函数 L(x,y,λ)' },
              { text: '(2) 求出 x、y' },
              { text: '(3) 求最小值' },
            ]),
            ask('拉格朗日函数怎么列？'),
          ],
        },
      ],
      { scene, autoAnswer: '嗯' },
    );
    await speak(h, '给我讲这道题');

    expect(h.session.tutor?.outline.length).toBe(3);
  });
});

/**
 * 真机复现过：拆题条目挂着具体符号、也没撞"理解题目"那道黑名单
 * （"理解题目条件和图形"——措辞绕开了枚举），但依然是个没有明确
 * "何时算完成"标准的条目。学生把同一个问题（"直线和圆可能有哪些
 * 位置关系"）答对了两次，账本却一直不打勾，老师一字不差地把这问题
 * 问了第二遍，讲了十几分钟卡在原地。黑名单堵不完所有措辞，但
 * "同一个问题问了两遍"这个症状本身能直接拦。
 */
describe('答对过的问题不能一字不差再问一遍', () => {
  it('同一句问题、已经判过 right——第二次问就被拒', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        {
          calls: [
            PLAN([{ text: '(1) 判断约束条件的几何图形' }]),
            call('canvas_highlight', { ids: ['sh_a'], ms: 0 }),
            ask('约束条件在坐标系中是什么图形？'),
          ],
        },
        { calls: [judge('right', '对，是直线')] },
        { calls: [draw(), zoomTo(), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('约束条件在坐标系中是什么图形？')] },
        { text: '好' },
      ],
      { scene, autoAnswer: '直线' },
    );
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user');
    // 第二次问的那一次以错误收场
    expect(asks.at(-1)!.call.state).toBe('error');
    expect(asks.at(-1)!.call.error).toContain('问过了');
    // 全场只真的问出去了一次
    expect(h.events('agent.ask')).toHaveLength(1);
  });

  it('答错/半对之后换个角度追问——不算重复，放行', async () => {
    const scene = new Scene();
    scene.create([{ type: 'text', id: 'sh_a', x: 0, y: 0, text: 'x + 2y = 5' }], {
      author: { id: 'u1', kind: 'user' },
    });
    const h = makeHarness(
      [
        {
          calls: [
            PLAN([{ text: '(1) 判断约束条件的几何图形' }]),
            call('canvas_highlight', { ids: ['sh_a'], ms: 0 }),
            ask('约束条件在坐标系中是什么图形？'),
          ],
        },
        { calls: [judge('partly', '不太准确')] },
        { calls: [draw(), zoomTo(), call('canvas_highlight', { ids: ['sh_a'], ms: 0 }), ask('再想想，这是一条什么样的线？')] },
        { text: '好' },
      ],
      { scene, autoAnswer: '直线' },
    );
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user');
    expect(asks.every((m) => m.call.state !== 'error')).toBe(true);
    expect(h.events('agent.ask')).toHaveLength(2);
  });
});

/**
 * 真机复现过一种绕开前两道闸的新花样：一条措辞完全具体、也没撞
 * 黑名单的条目（"求函数在约束条件下的极值点"），学生把它内含的每个
 * 子步骤都依次答对了，账本却始终不给这条打勾——老师只能换着说法
 * 一轮轮重问同一件事，措辞每次都不完全一样，精确匹配的闸也躲了过去。
 * 这道闸不看"问题长什么样"，只看"undone 的集合动没动"。
 */
describe('同一批小问答对过还是打不上勾——连着两轮就拦', () => {
  it('两轮都是「答对了但 undone 集合原样不动」——第二次重拆被拒', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求极值点' }]), ask('列出方程组？')] },
      // 答对了，但这次重拆没有把它标 done——undone 集合原样不动，第一次卡住
      { calls: [judge('right', '对'), PLAN([{ text: '(1) 求极值点' }]), ask('解出 x、y？')] },
      // 又答对了，undone 集合还是原样不动——第二次卡住，该被拦
      { calls: [judge('right', '对'), PLAN([{ text: '(1) 求极值点' }])] },
      { calls: [ask('还有别的问题吗？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const plans = h.events('agent.tool').filter((m) => m.call.name === 'tutor_plan');
    expect(plans.at(-1)!.call.state).toBe('error');
    expect(plans.at(-1)!.call.error).toContain('连着两轮都没打勾');
    // 这条小问依然没被打勾，也没被拆开
    expect(h.session.tutor?.outline).toEqual([{ text: '(1) 求极值点', done: false }]);
  });

  it('第二轮把它标成 done 了——不算卡住，正常放行', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求极值点' }]), ask('列出方程组？')] },
      { calls: [judge('right', '对'), PLAN([{ text: '(1) 求极值点' }]), ask('解出 x、y？')] },
      // 这次真的打勾了——undone 集合变了，不算卡住
      { calls: [judge('right', '对'), PLAN([{ text: '(1) 求极值点', done: true }])] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const plans = h.events('agent.tool').filter((m) => m.call.name === 'tutor_plan');
    expect(plans.every((m) => m.call.state !== 'error')).toBe(true);
    expect(h.session.tutor?.outline).toEqual([{ text: '(1) 求极值点', done: true }]);
  });
});

/**
 * 真机复现过：学生答"不太清楚"，老师判了 wrong，然后把同一句
 * "你知道如何求二阶常系数线性微分方程的通解吗？"一字不差地问了四遍，
 * 中间只穿插了一句"没关系，我们一起来学"，没有一次真的换角度或
 * 把问题拆小。原来 askedQuestions 只记 right 判定，理由是"答错之后
 * 换个角度追问是正常教学"——但这次事故说明"换角度"从来不是看判定
 * 结果，是看问题的文字有没有真的变。
 */
describe('判了 wrong 也不许一字不差把同一句问题再问一遍', () => {
  it('判 wrong 之后原样重问——被拒', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求通解' }]), ask('你知道怎么求通解吗？')] },
      { calls: [judge('wrong', '还不知道，我们一起学'), draw(), zoomTo(), ask('你知道怎么求通解吗？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user');
    expect(asks.at(-1)!.call.state).toBe('error');
    expect(asks.at(-1)!.call.error).toContain('问过了');
  });

  it('判 wrong 之后换一句更具体的问题——放行', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求通解' }]), ask('你知道怎么求通解吗？')] },
      { calls: [judge('wrong', '还不知道，我们一起学'), draw(), zoomTo(), ask('第一步是写特征方程，你能写出来吗？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const asks = h.events('agent.tool').filter((m) => m.call.name === 'interact_ask_user');
    expect(asks.every((m) => m.call.state !== 'error')).toBe(true);
  });
});
