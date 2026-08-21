import { describe, expect, it } from 'vitest';
import { PROBLEMS } from '../../scripts/problems.ts';

/**
 * 新补的题，答案要独立算一遍。
 *
 * 题库里的 answer 字段是基准打分的 ground truth——它错了，基准就会
 * 理直气壮地给出错误结论，比没有基准更糟（这一点在读题基准上已经栽过一次：
 * 77% 涨到 99%，涨的几乎全是我自己扣错的分）。所以这里不是"再抄一遍答案"，
 * 而是**换一条路算出来**，再和题库里写的对。
 */

const P = (id: string) => PROBLEMS.find((x) => x.id === id)!;
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe('H7 三角恒等变换', () => {
  it('第二象限 sin=3/5 → cos=−4/5，sin2α=−24/25，tan(α+π/4)=1/7', () => {
    const sin = 3 / 5;
    const cos = -Math.sqrt(1 - sin * sin); // 第二象限，余弦为负
    near(cos, -4 / 5);
    near(2 * sin * cos, -24 / 25);

    const tan = sin / cos;
    near(tan, -3 / 4);
    near((tan + 1) / (1 - tan), 1 / 7);

    expect(P('H7').answer).toContain('−24/25');
    expect(P('H7').answer).toContain('1/7');
  });
});

describe('H8 等差数列', () => {
  it('a3=7, a7=19 → d=3, a1=1, an=3n−2, S10=145', () => {
    // 从两个已知项反解，再正向验证整串
    const d = (19 - 7) / (7 - 3);
    const a1 = 7 - 2 * d;
    expect(d).toBe(3);
    expect(a1).toBe(1);

    const a = (n: number) => a1 + (n - 1) * d;
    expect(a(3)).toBe(7);
    expect(a(7)).toBe(19);
    expect(a(5)).toBe(3 * 5 - 2); // 通项公式 3n−2

    // 逐项累加，不套求和公式——公式记错的话这里会露出来
    let s = 0;
    for (let n = 1; n <= 10; n++) s += a(n);
    expect(s).toBe(145);
    expect(P('H8').answer).toContain('145');
  });
});

describe('H9 直线与圆', () => {
  it('配方得圆心(2,−1) r=3；d=7/5；相交，弦长 8√11/5', () => {
    // x²+y²−4x+2y−4=0 → (x−2)²+(y+1)²=9
    const cx = 2;
    const cy = -1;
    const r = 3;
    // 用圆上任取一点回代原方程，验证配方没错
    for (const t of [0, 1, 2, 3]) {
      const x = cx + r * Math.cos(t);
      const y = cy + r * Math.sin(t);
      near(x * x + y * y - 4 * x + 2 * y - 4, 0);
    }

    const d = Math.abs(3 * cx + 4 * cy + 5) / Math.hypot(3, 4);
    near(d, 7 / 5);
    expect(d).toBeLessThan(r); // 相交

    const chord = 2 * Math.sqrt(r * r - d * d);
    near(chord, (8 * Math.sqrt(11)) / 5);
    expect(P('H9').answer).toContain('8√11');
  });
});

describe('H10 古典概型', () => {
  it('3红2白取2个：都红 3/10，异色 3/5', () => {
    // 直接枚举所有取法，不套组合公式
    const balls = ['红', '红', '红', '白', '白'];
    let total = 0;
    let bothRed = 0;
    let diff = 0;
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) {
        total++;
        if (balls[i] === '红' && balls[j] === '红') bothRed++;
        if (balls[i] !== balls[j]) diff++;
      }
    }
    expect(total).toBe(10);
    near(bothRed / total, 3 / 10);
    near(diff / total, 3 / 5);
    expect(P('H10').answer).toContain('3/10');
    expect(P('H10').answer).toContain('3/5');
  });
});

describe('H11 正方体', () => {
  it('BD⊥平面ACC1A1（点积为零验证）；三棱锥 A1-ABD 体积 4/3', () => {
    // 棱长 2，A 在原点
    const A = [0, 0, 0];
    const B = [2, 0, 0];
    const C = [2, 2, 0];
    const D = [0, 2, 0];
    const A1 = [0, 0, 2];
    const sub = (p: number[], q: number[]) => p.map((v, i) => v - q[i]!);
    const dot = (p: number[], q: number[]) => p.reduce((s, v, i) => s + v * q[i]!, 0);

    const BD = sub(D, B);
    // BD 同时垂直于平面内两条相交直线 AC 和 AA1 → 垂直于该平面
    expect(dot(BD, sub(C, A))).toBe(0);
    expect(dot(BD, sub(A1, A))).toBe(0);

    const areaABD = 0.5 * 2 * 2;
    near((areaABD * 2) / 3, 4 / 3);
    expect(P('H11').answer).toContain('4/3');
  });
});

describe('U6 特征值', () => {
  it('[[3,1],[1,3]] 的特征值是 4 和 2，特征向量 (1,1) 和 (1,−1)', () => {
    const mul = (m: number[][], v: number[]) => m.map((row) => dot2(row, v));
    const dot2 = (p: number[], q: number[]) => p[0]! * q[0]! + p[1]! * q[1]!;
    const A = [
      [3, 1],
      [1, 3],
    ];
    // 直接验 Av = λv，不解特征方程
    expect(mul(A, [1, 1])).toEqual([4, 4]);
    expect(mul(A, [1, -1])).toEqual([2, -2]);
    expect(P('U6').answer).toContain('λ₁=4');
  });
});

describe('U7 正态分布', () => {
  it('N(2,9)：E=2, D=9, P(X>2)=0.5, P(−1<X<5)≈0.6826', () => {
    const mu = 2;
    const sigma = 3; // σ² = 9
    expect(sigma * sigma).toBe(9);
    // −1 和 5 正好是 μ±σ
    near((-1 - mu) / sigma, -1);
    near((5 - mu) / sigma, 1);

    // 一倍标准差区间约 68.27%
    const p = 0.682689492;
    expect(Math.abs(p - 0.6826)).toBeLessThan(1e-3);
    expect(P('U7').answer).toContain('0.6826');
  });
});

describe('题库自身', () => {
  it('id 不重复——插入时手滑插两遍是真发生过的', () => {
    const ids = PROBLEMS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每道题都有扫描件文件名和题干', () => {
    for (const p of PROBLEMS) {
      expect(p.image, p.id).toMatch(/\.png$/);
      expect(p.statement.length, p.id).toBeGreaterThan(10);
    }
  });
});
