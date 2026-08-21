import { describe, expect, it } from 'vitest';
import { PROBLEMS } from '../../scripts/problems.ts';

/**
 * 高中与本科题的答案验算。
 *
 * 为什么非测不可：这些答案是手算写进去的，而它们是读题基准的 ground truth。
 * ground truth 错了，基准给出的是一个**理直气壮的错误结论**——
 * 模型明明读对了却被判错，或者反过来。那比没有基准更糟。
 *
 * 所以这里不引用答案字符串里的数，而是从题给条件独立重算一遍，
 * 再和写进 answer 的数字对上。
 */

const byId = (id: string) => {
  const p = PROBLEMS.find((x) => x.id === id);
  if (!p) throw new Error(`题目 ${id} 不存在`);
  return p;
};

/** answer 里必须出现这些片段——重算结果和写下来的答案要对得上 */
function answerHas(id: string, ...parts: string[]): void {
  const a = byId(id).answer ?? '';
  for (const s of parts) expect(a, `${id} 的答案里应含「${s}」`).toContain(s);
}

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('高中题', () => {
  it('H1 导数与切线：f(x)=x³−3x²+2 在 x=1 处', () => {
    const f = (x: number) => x ** 3 - 3 * x ** 2 + 2;
    const df = (x: number) => 3 * x ** 2 - 6 * x;

    close(f(1), 0);
    close(df(1), -3);
    // 切线 y = f(1) + f'(1)(x-1) = -3x + 3
    const tangent = (x: number) => f(1) + df(1) * (x - 1);
    close(tangent(0), 3);
    close(tangent(2), -3);

    answerHas('H1', '3x²−6x', '−3x+3');
  });

  it('H2 椭圆：x²/25 + y²/9 = 1', () => {
    const a2 = 25;
    const b2 = 9;
    const c = Math.sqrt(a2 - b2);
    close(c, 4);
    close(c / Math.sqrt(a2), 0.8); // e = 4/5

    answerHas('H2', 'c=4', '4/5');
  });

  it('H3 等差数列：a₁=3, d=4', () => {
    const a1 = 3;
    const d = 4;
    const a10 = a1 + 9 * d;
    const s10 = (10 * (a1 + a10)) / 2;

    expect(a10).toBe(39);
    expect(s10).toBe(210);
    answerHas('H3', '39', '210');
  });

  it('H4 二倍角：sin α = 3/5，α 在第一象限', () => {
    const sin = 3 / 5;
    const cos = Math.sqrt(1 - sin ** 2); // 第一象限取正
    close(cos, 4 / 5);
    close(2 * sin * cos, 24 / 25);
    close(cos ** 2 - sin ** 2, 7 / 25);

    answerHas('H4', '4/5', '24/25', '7/25');
  });

  it('H5 正四棱锥：底边 4，高 3', () => {
    const a = 4;
    const h = 3;
    // 斜高：从顶点到底边中点，直角边是高和底面边心距 a/2
    const slant = Math.hypot(h, a / 2);
    close(slant, Math.sqrt(13));

    const lateral = 4 * 0.5 * a * slant; // 四个全等三角形
    close(lateral, 8 * Math.sqrt(13));
    close((a * a * h) / 3, 16);

    answerHas('H5', '√13', '16');
  });

  it('H6 古典概型：3 红 2 白取 2', () => {
    const C = (n: number, k: number): number => {
      let r = 1;
      for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
      return Math.round(r);
    };
    expect(C(5, 2)).toBe(10);

    const mixed = C(3, 1) * C(2, 1); // 6
    const same = C(3, 2) + C(2, 2); // 3 + 1 = 4
    expect(mixed / C(5, 2)).toBeCloseTo(3 / 5, 9);
    expect(same / C(5, 2)).toBeCloseTo(2 / 5, 9);
    // 两种情况必须互补，否则题目本身就有漏洞
    expect(mixed + same).toBe(C(5, 2));

    answerHas('H6', '3/5', '2/5');
  });
});

describe('本科题', () => {
  it('U1 分部积分：∫₀¹ x·eˣ dx = 1', () => {
    // 原函数 F(x) = x·eˣ − eˣ
    const F = (x: number) => x * Math.exp(x) - Math.exp(x);
    close(F(1) - F(0), 1);

    // 再用数值积分独立核一遍，防止原函数本身推错
    let sum = 0;
    const n = 200_000;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n;
      sum += x * Math.exp(x);
    }
    expect(sum / n).toBeCloseTo(1, 6);

    answerHas('U1', '= 1');
  });

  it('U2 特征值：A = [[2,1],[1,2]]', () => {
    // det(A − λI) = (2−λ)² − 1 = λ² − 4λ + 3
    const roots = [1, 3];
    for (const l of roots) close(l * l - 4 * l + 3, 0);

    // 特征向量验证：A·v = λ·v
    const mul = (v: [number, number]): [number, number] => [2 * v[0] + v[1], v[0] + 2 * v[1]];
    expect(mul([1, -1])).toEqual([1, -1]); // λ=1
    expect(mul([1, 1])).toEqual([3, 3]); // λ=3

    answerHas('U2', 'λ₁=1', 'λ₂=3');
  });

  it('U3 泊松分布：λ=2，P(X≤1)=3e⁻²', () => {
    const lam = 2;
    const p = (k: number) => (Math.exp(-lam) * lam ** k) / factorial(k);
    close(p(0) + p(1), 3 * Math.exp(-2));
    expect(3 * Math.exp(-2)).toBeCloseTo(0.406, 3);

    answerHas('U3', '3e⁻²', '0.406');
  });

  it('U4 二阶线性 ODE：y″−3y′+2y=0, y(0)=3, y′(0)=4', () => {
    // 特征根
    const roots = [1, 2];
    for (const r of roots) close(r * r - 3 * r + 2, 0);

    // 初值定系数：C₁+C₂=3，C₁+2C₂=4 → C₂=1, C₁=2
    const C1 = 2;
    const C2 = 1;
    const y = (x: number) => C1 * Math.exp(x) + C2 * Math.exp(2 * x);
    const dy = (x: number) => C1 * Math.exp(x) + 2 * C2 * Math.exp(2 * x);
    const ddy = (x: number) => C1 * Math.exp(x) + 4 * C2 * Math.exp(2 * x);

    close(y(0), 3);
    close(dy(0), 4);
    // 解真的满足方程——这一步才是验算，前面只是解方程组
    for (const x of [0, 0.3, 1.1]) close(ddy(x) - 3 * dy(x) + 2 * y(x), 0);

    answerHas('U4', 'C₁=2', 'C₂=1');
  });

  it('U5 偏导：f=x²y+3xy² 在 (1,2)', () => {
    const f = (x: number, y: number) => x ** 2 * y + 3 * x * y ** 2;
    const fx = (x: number, y: number) => 2 * x * y + 3 * y ** 2;
    const fy = (x: number, y: number) => x ** 2 + 6 * x * y;

    expect(fx(1, 2)).toBe(16);
    expect(fy(1, 2)).toBe(13);

    // 数值差分核对解析导数，防止求导本身抄错
    const h = 1e-6;
    expect((f(1 + h, 2) - f(1 - h, 2)) / (2 * h)).toBeCloseTo(16, 4);
    expect((f(1, 2 + h) - f(1, 2 - h)) / (2 * h)).toBeCloseTo(13, 4);

    answerHas('U5', '16', '13');
  });
});

describe('题库完整性', () => {
  it('id 不重复，扫描件名字也不重复', () => {
    const ids = PROBLEMS.map((p) => p.id);
    const imgs = PROBLEMS.map((p) => p.image);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(imgs).size).toBe(imgs.length);
  });

  it('高中和本科题都带 stage，基准才能按学段分组', () => {
    for (const p of PROBLEMS.filter((x) => /^[HU]\d/.test(x.id))) {
      expect(p.stage, `${p.id} 缺 stage`).toBeDefined();
    }
  });

  it('每道题都有 answer——没有答案就没法当 ground truth', () => {
    for (const p of PROBLEMS) expect(p.answer, `${p.id} 缺 answer`).toBeTruthy();
  });
});

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}
