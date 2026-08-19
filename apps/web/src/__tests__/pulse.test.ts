import { afterEach, describe, expect, it, vi } from 'vitest';
import { PULSE_PERIOD, _pulseListeners, _pulseRunning, subscribeToPulse } from '../canvas/pulse.js';

/**
 * 呼吸时钟。
 *
 * 关键不是曲线好不好看，是**只有一条 rAF**：一次可能同时亮着十几个图元，
 * 每个自己跑一条既浪费，相位还会各走各的——看上去像在抖而不是在呼吸。
 */

const frames: FrameRequestCallback[] = [];
let nextId = 1;

vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  frames.push(cb);
  return nextId++;
});
vi.stubGlobal('cancelAnimationFrame', () => {});

/** 推进到某个时刻，只跑最新排队的那一帧 */
function advance(t: number): void {
  const cb = frames.pop();
  frames.length = 0;
  cb?.(t);
}

afterEach(() => {
  frames.length = 0;
});

describe('呼吸时钟', () => {
  it('十个订阅者只跑一条 rAF，而且相位一致', () => {
    const seen: number[][] = Array.from({ length: 10 }, () => []);
    const offs = seen.map((bucket) => subscribeToPulse((p) => bucket.push(p)));

    expect(_pulseListeners()).toBe(10);
    advance(0);
    advance(PULSE_PERIOD / 4);

    // 同一帧里所有人拿到同一个相位
    const last = seen.map((b) => b.at(-1));
    expect(new Set(last).size).toBe(1);
    expect(last[0]).toBeCloseTo(0.25, 5);

    offs.forEach((off) => off());
  });

  it('最后一个退订之后时钟停下来，不在后台空转', () => {
    const off = subscribeToPulse(() => {});
    advance(0);
    expect(_pulseRunning()).toBe(true);

    off();
    expect(_pulseListeners()).toBe(0);
    expect(_pulseRunning()).toBe(false);
  });

  it('相位在 0~1 之间循环，跨周期不会跳变', () => {
    const got: number[] = [];
    const off = subscribeToPulse((p) => got.push(p));
    advance(0);
    advance(PULSE_PERIOD * 0.9);
    advance(PULSE_PERIOD * 1.1);
    off();

    expect(got.every((p) => p >= 0 && p < 1)).toBe(true);
    expect(got.at(-1)).toBeCloseTo(0.1, 5);
  });
});
