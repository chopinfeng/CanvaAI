import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdleQueue } from '../idleQueue';

/**
 * 这里守的是一条产品约定：AI 只在用户**彻底停手**之后才介入。
 * "停手"包含鼠标移动——手还在画布上游移就说明人还在想。
 */

let flushed: string[][];
let q: IdleQueue<string>;

const IDLE = 5000;

beforeEach(() => {
  vi.useFakeTimers();
  flushed = [];
  q = new IdleQueue<string>({
    idleMs: IDLE,
    onFlush: (items) => flushed.push(items),
    now: () => Date.now(),
  });
});

afterEach(() => {
  q.dispose();
  vi.useRealTimers();
});

describe('停手判定', () => {
  it('攒够静默时间才交出去', () => {
    q.push('a');
    vi.advanceTimersByTime(IDLE - 1);
    expect(flushed).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([['a']]);
  });

  it('鼠标动一下就重新计时', () => {
    q.push('a');
    vi.advanceTimersByTime(4000);

    q.markActive(); // 用户挪了下鼠标
    vi.advanceTimersByTime(4000);
    expect(flushed).toEqual([]); // 距离上次动作才 4s，还不够

    vi.advanceTimersByTime(1000);
    expect(flushed).toEqual([['a']]);
  });

  it('一直在动就一直不打扰', () => {
    q.push('a');
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1000);
      q.markActive();
    }
    expect(flushed).toEqual([]);

    vi.advanceTimersByTime(IDLE);
    expect(flushed).toEqual([['a']]);
  });

  it('期间画的内容攒成一批，而不是分次骚扰', () => {
    q.push('a');
    vi.advanceTimersByTime(1000);
    q.markActive();
    q.push('b');
    vi.advanceTimersByTime(1000);
    q.markActive();
    q.push('c');

    vi.advanceTimersByTime(IDLE);
    expect(flushed).toEqual([['a', 'b', 'c']]);
  });

  it('交出去之后队列清空，不会重复提交', () => {
    q.push('a');
    vi.advanceTimersByTime(IDLE);
    expect(flushed).toEqual([['a']]);

    vi.advanceTimersByTime(IDLE * 3);
    expect(flushed).toEqual([['a']]);
  });

  it('没有内容时不会空放一次', () => {
    q.markActive();
    vi.advanceTimersByTime(IDLE * 2);
    expect(flushed).toEqual([]);
  });
});

describe('闸门：人不在看就不放行', () => {
  let foreground: boolean;
  let gq: IdleQueue<string>;
  let out: string[][];

  beforeEach(() => {
    foreground = true;
    out = [];
    gq = new IdleQueue<string>({
      idleMs: IDLE,
      onFlush: (items) => out.push(items),
      canFlush: () => foreground,
      now: () => Date.now(),
    });
  });

  afterEach(() => gq.dispose());

  it('页面在后台时，静止再久也不动手', () => {
    gq.push('a');
    foreground = false;

    vi.advanceTimersByTime(IDLE * 5);
    expect(out).toEqual([]);
    expect(gq.isGated).toBe(true);
    expect(gq.pending).toBe(1); // 内容还攒着，没丢
  });

  it('切回前台不会立刻动手，而是重新计时', () => {
    gq.push('a');
    foreground = false;
    vi.advanceTimersByTime(IDLE * 2);
    expect(out).toEqual([]);

    foreground = true;
    gq.resume();
    expect(out).toEqual([]); // 人刚回来，画布不该马上自己动

    vi.advanceTimersByTime(IDLE - 1);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(out).toEqual([['a']]);
  });

  it('后台期间继续攒，回来后一批交出去', () => {
    foreground = false;
    gq.push('a');
    vi.advanceTimersByTime(IDLE * 2);
    gq.push('b');
    vi.advanceTimersByTime(IDLE * 2);
    expect(out).toEqual([]);

    foreground = true;
    gq.resume();
    vi.advanceTimersByTime(IDLE);
    expect(out).toEqual([['a', 'b']]);
  });

  it('回到前台后又切走，仍然不放行', () => {
    gq.push('a');
    foreground = false;
    vi.advanceTimersByTime(IDLE * 2);

    foreground = true;
    gq.resume();
    vi.advanceTimersByTime(2000);

    foreground = false; // 又切走了
    vi.advanceTimersByTime(IDLE * 3);
    expect(out).toEqual([]);
  });

  it('flushNow 不受闸门限制 —— 能打字就说明人在', () => {
    gq.push('a');
    foreground = false;
    vi.advanceTimersByTime(IDLE * 2);
    expect(out).toEqual([]);

    gq.flushNow();
    expect(out).toEqual([['a']]);
    expect(gq.isGated).toBe(false);
  });
});

describe('插队与取消', () => {
  it('flushNow 立刻交出去 —— 用户直接开口时用', () => {
    q.push('a', 'b');
    vi.advanceTimersByTime(100);
    q.flushNow();
    expect(flushed).toEqual([['a', 'b']]);

    // 原来的定时器不该再触发一次
    vi.advanceTimersByTime(IDLE * 2);
    expect(flushed).toEqual([['a', 'b']]);
  });

  it('flushNow 在没有内容时什么也不做', () => {
    q.flushNow();
    expect(flushed).toEqual([]);
  });

  it('cancel 丢弃攒下的内容', () => {
    q.push('a');
    q.cancel();
    vi.advanceTimersByTime(IDLE * 2);
    expect(flushed).toEqual([]);
    expect(q.pending).toBe(0);
  });

  it('pending 反映还攒着多少', () => {
    expect(q.pending).toBe(0);
    q.push('a', 'b');
    expect(q.pending).toBe(2);
    vi.advanceTimersByTime(IDLE);
    expect(q.pending).toBe(0);
  });
});
