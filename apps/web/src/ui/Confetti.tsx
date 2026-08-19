import { useEffect, useRef } from 'react';
import { useStore } from '../store.js';

/**
 * 讲完一道题就撒花。
 *
 * 这不是装饰。辅导是一件要来回十几轮的苦差事，中间全是"再想想""不对，你看这条边"——
 * 走到头的那一下必须有个明确的、身体能感觉到的收束，不然十几轮下来只剩累。
 * 所以它只在**真讲完**的时候放（tutor_finish 成功），用户自己要走、
 * 中途停下都不放——见者有份就不值钱了。
 *
 * 自己画，不引第三方库：这点物理不值得一个依赖，而且外部库的默认参数
 * 大多太吵（满屏、几秒、还带声音）。
 */

const COLORS = ['#f59e0b', '#2563eb', '#059669', '#dc2626', '#7c3aed', '#db2777'];

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 半宽/半高，纸片是矩形不是圆点 */
  w: number;
  h: number;
  rot: number;
  vrot: number;
  color: string;
  /** 翻面用的相位——纸片会侧过来变窄，是"纸"而不是"糖豆"的关键 */
  flip: number;
  vflip: number;
}

const GRAVITY = 0.32;
const DRAG = 0.992;
const LIFE_MS = 3200;

export function Confetti() {
  const nonce = useStore((s) => s.celebrate);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (nonce === null) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    // 系统里关了动效就别撒——晕动症是真的，一屏乱飞的纸片是典型诱因
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);

    /**
     * 从左右下角斜着往上打，不是从顶上往下掉。
     * 往下掉像"下雨"，斜着炸开才像庆祝——起手那一下的加速度是情绪的来源。
     */
    const bits: Bit[] = [];
    for (const side of [0, 1]) {
      const originX = side === 0 ? W * 0.06 : W * 0.94;
      const aim = side === 0 ? -0.55 : -Math.PI + 0.55; // 朝斜上方
      for (let i = 0; i < 70; i++) {
        const spread = (Math.random() - 0.5) * 0.9;
        const speed = 13 + Math.random() * 13;
        bits.push({
          x: originX,
          y: H * 0.92,
          vx: Math.cos(aim + spread) * speed,
          vy: Math.sin(aim + spread) * speed,
          w: 3 + Math.random() * 4,
          h: 5 + Math.random() * 6,
          rot: Math.random() * Math.PI,
          vrot: (Math.random() - 0.5) * 0.3,
          color: COLORS[(Math.random() * COLORS.length) | 0]!,
          flip: Math.random() * Math.PI,
          vflip: 0.1 + Math.random() * 0.12,
        });
      }
    }

    let raf = 0;
    let t0 = 0;

    const frame = (t: number) => {
      if (!t0) t0 = t;
      const age = t - t0;
      ctx.clearRect(0, 0, W, H);

      // 最后 900ms 整体淡出，别"啪"地一下消失
      const fade = Math.min(1, Math.max(0, (LIFE_MS - age) / 900));

      for (const b of bits) {
        b.vy += GRAVITY;
        b.vx *= DRAG;
        b.vy *= DRAG;
        b.x += b.vx;
        b.y += b.vy;
        b.rot += b.vrot;
        b.flip += b.vflip;

        if (b.y - b.h > H) continue;

        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.rot);
        // 翻面：横向压扁到 0 再回来，看上去就像纸片在空中翻转
        ctx.scale(Math.cos(b.flip), 1);
        ctx.globalAlpha = fade;
        ctx.fillStyle = b.color;
        ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        ctx.restore();
      }

      if (age < LIFE_MS) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, W, H);
    };
  }, [nonce]);

  if (nonce === null) return null;
  // pointer-events:none —— 庆祝归庆祝，别挡着他继续画
  return <canvas ref={canvasRef} className="confetti" aria-hidden="true" />;
}
