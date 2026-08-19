/**
 * 力导向布局，够用就行的那种。
 *
 * 不引 d3-force：这里最多九十个节点，需要的就是斥力 + 弹簧 + 向心力三项，
 * 六十行写完，还能把"焦点钉在中间"这条规则直接写进去——
 * 那是这张图唯一真正重要的布局约束（整页就是围绕焦点看两跳）。
 * 引一个库反而要绕过它的默认行为。
 */

export interface Sim {
  step(): void;
  pos(id: string): { x: number; y: number } | undefined;
}

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const REPULSE = 5200;
const SPRING = 0.012;
const REST = 78;
const CENTER = 0.006;
const DAMP = 0.86;
/** 稳下来之后就别再抖了——一直微动的图看着很吵 */
const SLEEP = 0.02;

export function layout(
  ids: string[],
  edges: Array<{ source: string; target: string }>,
  root: string,
): Sim {
  const pos = new Map<string, P>();

  // 初始摆成一圈：从纯随机开始容易缠成结，解不开
  ids.forEach((id, i) => {
    const a = (i / Math.max(1, ids.length)) * Math.PI * 2;
    const r = id === root ? 0 : 120 + (i % 3) * 40;
    pos.set(id, { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 });
  });

  const links = edges.filter((e) => pos.has(e.source) && pos.has(e.target));
  let asleep = false;

  return {
    step() {
      if (asleep) return;
      let motion = 0;

      // 斥力：所有点两两推开
      for (let i = 0; i < ids.length; i++) {
        const a = pos.get(ids[i]!)!;
        for (let j = i + 1; j < ids.length; j++) {
          const b = pos.get(ids[j]!)!;
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            // 完全重合时给个随机方向，否则永远分不开
            dx = Math.cos(i * 2.4) * 0.5;
            dy = Math.sin(i * 2.4) * 0.5;
            d2 = 1;
          }
          const f = REPULSE / d2;
          const d = Math.sqrt(d2);
          a.vx += (dx / d) * f;
          a.vy += (dy / d) * f;
          b.vx -= (dx / d) * f;
          b.vy -= (dy / d) * f;
        }
      }

      // 弹簧：有边的往一起拉
      for (const e of links) {
        const a = pos.get(e.source)!;
        const b = pos.get(e.target)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = (d - REST) * SPRING;
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }

      for (const id of ids) {
        const p = pos.get(id)!;
        if (id === root) {
          // 焦点钉死在中心：整页就是"围绕它看两跳"，它飘走了这页就散了
          p.x = 0;
          p.y = 0;
          p.vx = 0;
          p.vy = 0;
          continue;
        }
        p.vx -= p.x * CENTER;
        p.vy -= p.y * CENTER;
        p.vx *= DAMP;
        p.vy *= DAMP;
        p.x += p.vx;
        p.y += p.vy;
        motion += Math.abs(p.vx) + Math.abs(p.vy);
      }

      if (motion / Math.max(1, ids.length) < SLEEP) asleep = true;
    },

    pos(id) {
      const p = pos.get(id);
      return p ? { x: p.x, y: p.y } : undefined;
    },
  };
}
