/**
 * 攒着，等人真的停手了再交出去。
 *
 * AI 不该在用户画到一半就插进来——那既打断思路，也常常是对着半成品做判断。
 * 判定"停手"必须把**鼠标移动**算进去：手还在画布上游移，说明人还在想，
 * 只看"有没有新图形产生"会误判成已经停了。
 *
 * 用户一有动作就重新计时；期间产生的内容全部攒着，
 * 停够 idleMs 之后一次性交给 Agent（它因此看到的是完整的一批，而不是零碎的笔画）。
 */
export interface IdleQueueOptions<T> {
  idleMs: number;
  onFlush: (items: T[]) => void;
  /**
   * 闸门：返回 false 时即使已经静止够久也不放行。
   *
   * 用来挡住"页面在后台或没获得焦点"的情况——人根本没在看，
   * 这时候让 AI 动手，等他切回来会发现画布凭空变了样。
   * 闸门重新打开时调 resume()，会重新开始计时而不是立刻放行。
   */
  canFlush?: () => boolean;
  /** 便于测试注入时钟 */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export class IdleQueue<T> {
  private items: T[] = [];
  private timer: number | null = null;
  private lastActivity: number;

  /** 静止够久了，但闸门关着，正等它打开 */
  private gated = false;

  private readonly idleMs: number;
  private readonly onFlush: (items: T[]) => void;
  private readonly canFlush: () => boolean;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;

  constructor(opts: IdleQueueOptions<T>) {
    this.idleMs = opts.idleMs;
    this.onFlush = opts.onFlush;
    this.canFlush = opts.canFlush ?? (() => true);
    this.now = opts.now ?? (() => Date.now());
    // 用 globalThis 而不是 window：这块逻辑是纯的，无头测试里也要能跑
    this.setTimer = opts.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.clearTimer = opts.clearTimer ?? ((id) => globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
    this.lastActivity = this.now();
  }

  get pending(): number {
    return this.items.length;
  }

  /** 有内容要交给 Agent，但先攒着 */
  push(...items: T[]): void {
    if (items.length === 0) return;
    this.items.push(...items);
    this.arm();
  }

  /**
   * 用户有动作（移动鼠标、按键、滚动、落笔…）——重新计时。
   * 这个方法会被 pointermove 高频调用，所以只更新一个时间戳，不做别的。
   */
  markActive(): void {
    this.lastActivity = this.now();
  }

  /**
   * 不等了，立刻交出去（比如用户直接开口说话）。
   * 这是用户的明确动作，不受闸门限制——能打字就说明人在。
   */
  flushNow(): void {
    this.disarm();
    this.gated = false;
    const items = this.items;
    this.items = [];
    if (items.length > 0) this.onFlush(items);
  }

  /** 丢弃攒下的内容（比如切换房间） */
  cancel(): void {
    this.disarm();
    this.gated = false;
    this.items = [];
  }

  dispose(): void {
    this.cancel();
  }

  /**
   * 不轮询：每次正好睡到"距离停手够久"还差的那段时间，
   * 醒来发现用户又动过就接着睡。
   */
  private arm(): void {
    if (this.timer !== null) return;
    const tick = () => {
      this.timer = null;
      if (this.items.length === 0) return;

      const idle = this.now() - this.lastActivity;
      if (idle < this.idleMs) {
        this.timer = this.setTimer(tick, this.idleMs - idle);
        return;
      }

      // 静止够久了，但人不在看——停在这儿等，不要空转轮询
      if (!this.canFlush()) {
        this.gated = true;
        return;
      }

      const items = this.items;
      this.items = [];
      this.gated = false;
      this.onFlush(items);
    };
    this.timer = this.setTimer(tick, this.idleMs);
  }

  /**
   * 闸门打开了（页面切回前台并重新获得焦点）。
   *
   * 不立刻放行：人刚切回来，画布突然自己动起来同样吓人。
   * 重新计时，等他坐定 idleMs 再说。
   */
  resume(): void {
    this.markActive();
    if (this.gated) {
      this.gated = false;
      this.arm();
    }
  }

  /** 仅用于测试与调试：是否正卡在闸门上 */
  get isGated(): boolean {
    return this.gated;
  }

  private disarm(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
