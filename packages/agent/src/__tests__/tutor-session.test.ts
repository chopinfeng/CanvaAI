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
      { calls: [judge('right', '对'), PLAN([{ text: '(1) 求 DF 与 FC', done: true }, { text: '(2) 求线段 BE' }]), ask('BE 呢？')] },
      {
        calls: [
          judge('right', '也对'),
          PLAN([{ text: '(1) 求 DF 与 FC', done: true }, { text: '(2) 求线段 BE', done: true }]),
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
    expect(modes.at(-1)!.note).toContain('2 个小问');

    expect(h.events('agent.todo').at(-1)!.items).toEqual([]);
    expect(h.events('agent.say').at(-1)!.text).toContain('折叠');
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

  it('这一轮提过问就不再打扰', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }]), ask('AB 翻折过去变成哪条边？')] },
      { text: '等你回答。' },
    ]);
    await speak(h, '给我讲这道题');

    const nudged = h.loop
      .getHistory()
      .some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('球断在这里'));
    expect(nudged).toBe(false);
  });

  it('提醒只发一次，不会两边空转到步数上限', async () => {
    const h = tutor([
      { calls: [PLAN([{ text: '(1) 求 DF' }])] },
      { text: '讲完了。' },
      { text: '真的讲完了。' }, // 还是不提问
    ]);
    await speak(h, '给我讲这道题');

    const nudges = h.loop
      .getHistory()
      .filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[系统] 这一轮你没有向用户提问'));
    expect(nudges).toHaveLength(1);
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
      { calls: [judge('right', '对，翻折后 AF=AB'), ask('那 DF 呢？')] },
      { text: '好' },
    ]);
    await speak(h, '给我讲这道题');

    const rejected = h
      .events('agent.tool')
      .filter((m) => m.call.name === 'interact_ask_user' && m.call.state === 'error');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.call.error).toContain('你还没说这答案对不对');
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
      { calls: [judge('partly', '方向对，但 AF 对应的是 AB 不是 AD'), ask('那再看看 AD？')] },
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
          rightSince: 0,
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
      session: { ...base, tutor: { goal: '讲讲这题', outline: [], startedTurn: 1, pending: null, rightSince: 0 } },
      events: [],
      turnNo: 1,
    });
    expect(header).toContain('还没拆题');
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
