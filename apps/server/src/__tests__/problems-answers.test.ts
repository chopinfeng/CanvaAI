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

/* ------------------------------------------------------------------ *
 * 本科偏难那一批
 *
 * 这几道都不是"套一个公式"：条件极值要建拉格朗日函数、非齐次微分方程
 * 撞共振要升幂、含参方程组要分三种情况讨论。答案越长越要独立算——
 * 抄一遍验不出什么，得换一条路走到同一个数。
 * ------------------------------------------------------------------ */

describe('U8 条件极值', () => {
  it('最小值 5 = 原点到直线 x+2y=5 的距离平方', () => {
    // 换一条路：不解拉格朗日，直接用点到直线距离
    const d = Math.abs(0 + 2 * 0 - 5) / Math.hypot(1, 2);
    near(d * d, 5);

    // 驻点 (1,2) 在约束上，且函数值就是 5
    expect(1 + 2 * 2).toBe(5);
    near(1 * 1 + 2 * 2, 5);

    // 沿约束直线扫一圈，没有比它更小的
    for (let t = -3; t <= 3; t += 0.25) {
      const x = 1 + 2 * t; // 方向向量 (2,−1) 与 (1,2) 垂直，保证仍在直线上
      const y = 2 - t;
      near(x + 2 * y, 5);
      expect(x * x + y * y).toBeGreaterThanOrEqual(5 - 1e-9);
    }
    expect(P('U8').answer).toContain('x=1, y=2');
  });
});

describe('U9 实对称矩阵', () => {
  const A = [
    [2, 1, 1],
    [1, 2, 1],
    [1, 1, 2],
  ];
  const mul = (m: number[][], v: number[]) => m.map((r) => r.reduce((s, x, i) => s + x * v[i]!, 0));

  it('特征值 4,1,1 —— 直接验 Av=λv，不解特征方程', () => {
    expect(mul(A, [1, 1, 1])).toEqual([4, 4, 4]);
    expect(mul(A, [1, -1, 0])).toEqual([1, -1, 0]);
    expect(mul(A, [1, 0, -1])).toEqual([1, 0, -1]);
  });

  it('|A|=4，tr(A)=6，且与特征值一致', () => {
    const det =
      A[0]![0]! * (A[1]![1]! * A[2]![2]! - A[1]![2]! * A[2]![1]!) -
      A[0]![1]! * (A[1]![0]! * A[2]![2]! - A[1]![2]! * A[2]![0]!) +
      A[0]![2]! * (A[1]![0]! * A[2]![1]! - A[1]![1]! * A[2]![0]!);
    expect(det).toBe(4);
    expect(4 * 1 * 1).toBe(det); // 行列式 = 特征值之积

    const tr = A[0]![0]! + A[1]![1]! + A[2]![2]!;
    expect(tr).toBe(6);
    expect(4 + 1 + 1).toBe(tr); // 迹 = 特征值之和
  });
});

describe('U10 二阶非齐次（共振）', () => {
  // y = −3eˣ + 3e²ˣ − 2xeˣ 及其两阶导数，手推后在这里数值复核
  const y = (x: number) => -3 * Math.exp(x) + 3 * Math.exp(2 * x) - 2 * x * Math.exp(x);
  const y1 = (x: number) => -5 * Math.exp(x) + 6 * Math.exp(2 * x) - 2 * x * Math.exp(x);
  const y2 = (x: number) => -7 * Math.exp(x) + 12 * Math.exp(2 * x) - 2 * x * Math.exp(x);

  it('导数式子本身没抄错——和数值微分对得上', () => {
    const h = 1e-5;
    for (const x of [-0.5, 0, 0.7, 1.3]) {
      expect(Math.abs((y(x + h) - y(x - h)) / (2 * h) - y1(x))).toBeLessThan(1e-4);
      expect(Math.abs((y1(x + h) - y1(x - h)) / (2 * h) - y2(x))).toBeLessThan(1e-4);
    }
  });

  it('代回原方程恒等于 2eˣ', () => {
    for (const x of [-1, -0.3, 0, 0.5, 1, 2]) {
      const lhs = y2(x) - 3 * y1(x) + 2 * y(x);
      expect(Math.abs(lhs - 2 * Math.exp(x))).toBeLessThan(1e-9);
    }
  });

  it('满足初值 y(0)=0, y′(0)=1', () => {
    near(y(0), 0);
    near(y1(0), 1);
    expect(P('U10').answer).toContain('C₁=−3, C₂=3');
  });

  it('共振是真的——r=1 确实是特征根，所以特解必须带 x', () => {
    const charPoly = (r: number) => r * r - 3 * r + 2;
    expect(charPoly(1)).toBe(0);
    expect(charPoly(2)).toBe(0);
    // 不带 x 的设法 y*=Aeˣ 代进去左端恒为 0，凑不出 2eˣ
    const A = 1;
    near(A * Math.exp(1) - 3 * A * Math.exp(1) + 2 * A * Math.exp(1), 0);
  });
});

describe('U11 幂级数', () => {
  const partial = (x: number, N: number) => {
    let s = 0;
    for (let n = 1; n <= N; n++) s += Math.pow(x, n) / n;
    return s;
  };

  it('和函数 S(x) = −ln(1−x)：部分和收敛到它', () => {
    for (const x of [0.5, -0.5, 0.9, -0.9]) {
      expect(Math.abs(partial(x, 4000) - -Math.log(1 - x))).toBeLessThan(1e-3);
    }
  });

  it('x=1 发散（调和级数），x=−1 收敛到 −ln2', () => {
    // 调和级数部分和随 N 无界增长
    expect(partial(1, 10000)).toBeGreaterThan(partial(1, 1000) + 2);
    // 交错调和级数收敛
    expect(Math.abs(partial(-1, 200001) - -Math.log(2))).toBeLessThan(1e-4);
    expect(P('U11').answer).toContain('[−1, 1)');
  });
});

describe('U12 贝叶斯', () => {
  it('次品率 0.032，次品来自乙的概率 0.625', () => {
    // 换一条路：拿 10000 件直接数，不套公式
    const total = 10000;
    const fromA = total * 0.6;
    const fromB = total * 0.4;
    const badA = fromA * 0.02;
    const badB = fromB * 0.05;
    const bad = badA + badB;

    expect(badA).toBe(120);
    expect(badB).toBe(200);
    near(bad / total, 0.032);
    near(badB / bad, 0.625);
    expect(P('U12').answer).toContain('0.625');
  });
});

describe('U13 重积分', () => {
  it('四分之一圆盘上 ∬(x²+y²) = 2π', () => {
    // 换一条路：直角坐标下做黎曼和，不用极坐标
    const R = 2;
    const N = 2000;
    const h = R / N;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * h;
      for (let j = 0; j < N; j++) {
        const y = (j + 0.5) * h;
        if (x * x + y * y <= R * R) sum += (x * x + y * y) * h * h;
      }
    }
    expect(Math.abs(sum - 2 * Math.PI)).toBeLessThan(0.02);
    expect(P('U13').answer).toContain('2π');
  });
});

describe('U14 含参方程组', () => {
  const det = (l: number) =>
    l * (l * l - 1) - 1 * (l - 1) + 1 * (1 - l); // |[[λ,1,1],[1,λ,1],[1,1,λ]]|

  it('系数行列式 = (λ+2)(λ−1)²', () => {
    for (const l of [-3, -2, -1, 0, 0.5, 1, 2, 5]) {
      near(det(l), (l + 2) * (l - 1) * (l - 1));
    }
  });

  it('λ≠1 且 λ≠−2 时行列式非零 → 唯一解', () => {
    for (const l of [-3, 0, 2, 7]) expect(Math.abs(det(l))).toBeGreaterThan(1e-9);
  });

  it('λ=1：三个方程变成同一个，无穷多解', () => {
    // 右端依次是 1, λ, λ² = 1, 1, 1，左端也都是 x1+x2+x3
    expect(det(1)).toBe(0);
    const rhs = [1, 1, 1 * 1];
    expect(new Set(rhs).size).toBe(1);
  });

  it('λ=−2：三式相加左端为 0、右端为 3，矛盾 → 无解', () => {
    expect(det(-2)).toBe(0);
    const l = -2;
    // 每列系数之和都是 λ+1+1 = 0
    expect(l + 1 + 1).toBe(0);
    // 右端之和 1+λ+λ² = 1−2+4 = 3 ≠ 0
    expect(1 + l + l * l).toBe(3);
    expect(P('U14').answer).toContain('无解');
  });
});
