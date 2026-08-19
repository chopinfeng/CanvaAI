import { useEffect, useState } from 'react';

/**
 * 高亮的呼吸动画。
 *
 * 为什么不是静态描边：讲题时"我说的是这条边"必须一眼认出来。
 * 静态的橙色描边混在一堆线里并不跳眼，尤其图上本来就有蓝线红字；
 * 动的东西人眼会自动追过去，这是免费的注意力。
 *
 * 为什么共用一个时钟：一次可能同时亮着十几个图元，每个都开一条
 * requestAnimationFrame 是十几倍的浪费，而且它们的相位会各走各的，
 * 看上去像在抖而不是在呼吸。这里全局只跑一条，所有高亮同步起伏。
 */

type Listener = (phase: number) => void;

const listeners = new Set<Listener>();
let raf = 0;
/** 起始时刻。用 null 而不是 0 当"还没开始"——rAF 的时间戳真的可能是 0 */
let t0: number | null = null;

/** 一个完整呼吸周期的毫秒数。太快像报警，太慢看不出在动 */
export const PULSE_PERIOD = 1600;

function tick(t: number): void {
  if (t0 === null) t0 = t;
  const phase = ((t - t0) % PULSE_PERIOD) / PULSE_PERIOD;
  for (const l of listeners) l(phase);
  raf = requestAnimationFrame(tick);
}

/**
 * 订阅呼吸时钟，返回退订函数。
 *
 * 和 React 拆开是为了能测：时钟本身（相位怎么走、最后一个退订后 rAF 要停）
 * 是纯逻辑，不需要 DOM 就能验证。
 */
export function subscribeToPulse(l: Listener): () => void {
  listeners.add(l);
  if (raf === 0) raf = requestAnimationFrame(tick);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      cancelAnimationFrame(raf);
      raf = 0;
      t0 = null;
    }
  };
}

/**
 * 返回 0~1 的呼吸值（正弦，两端平缓）。
 * active 为 false 时固定返回 0，也不订阅时钟——不亮的图元一点开销都不该有。
 */
export function usePulse(active: boolean): number {
  const [v, setV] = useState(0);

  useEffect(() => {
    if (!active) {
      setV(0);
      return;
    }
    return subscribeToPulse((phase) => setV((1 - Math.cos(phase * Math.PI * 2)) / 2));
  }, [active]);

  return active ? v : 0;
}

/** 当前订阅者数量，供测试断言"退订之后时钟真的停了" */
export const _pulseListeners = (): number => listeners.size;
export const _pulseRunning = (): boolean => raf !== 0;
