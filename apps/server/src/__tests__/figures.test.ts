import { describe, expect, it } from 'vitest';
import {
  S1_FIG,
  S3_FIG,
  S6_FIG,
  S2_FIG,
  S4_FIG,
  S7_FIG,
  S8_FIG,
  T1_FIG,
  T2_FIG,
  T3_FIG,
  T9_FIG,
  T8_FIG,
  T10_FIG,
} from '../../scripts/figures.ts';
import { buildFigure, type FigureSpec } from '../../scripts/figure.ts';

/**
 * 矢量化图形的坐标必须由题给条件推出来，而不是"看着差不多"。
 *
 * 凭感觉摆的图会被 Agent 当真去测量，得出的数是错的——那比没有图更糟。
 * 所以每张图都在这里按原题条件复验一遍：给定的长度、角度、平行、共线、
 * 中点关系，一条都不能对不上。
 */

type P = readonly [number, number];

const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** ∠(a v b)，角度制 */
const angle = (v: P, a: P, b: P) => {
  const u1 = [a[0] - v[0], a[1] - v[1]];
  const u2 = [b[0] - v[0], b[1] - v[1]];
  const cos = (u1[0]! * u2[0]! + u1[1]! * u2[1]!) / (Math.hypot(...(u1 as [number, number])) * Math.hypot(...(u2 as [number, number])));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
};

/** 三点共线（叉积为 0） */
const collinear = (a: P, b: P, c: P) =>
  Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));

const pts = (f: FigureSpec) => f.pts as Record<string, P>;
const near = (v: number, target: number, tol = 1e-9) => expect(Math.abs(v - target)).toBeLessThan(tol);

describe('S1 等腰△ABC，AB=AC=5，BC=8，OB=OD=2', () => {
  const p = pts(S1_FIG);
  it('三边长符合题设', () => {
    near(dist(p.A!, p.B!), 5);
    near(dist(p.A!, p.C!), 5);
    near(dist(p.B!, p.C!), 8);
  });
  it('O 在 BC 上且 OB=2，D 在 BA 上且 OD=2', () => {
    near(collinear(p.B!, p.C!, p.O!), 0);
    near(dist(p.O!, p.B!), 2);
    near(collinear(p.B!, p.A!, p.D!), 0, 1e-9);
    near(dist(p.O!, p.D!), 2, 1e-9);
  });
  it('E 在射线 OD 的延长线上，且落在射线 CA 上 A 之外', () => {
    near(collinear(p.O!, p.D!, p.E!), 0, 1e-9);
    near(collinear(p.C!, p.A!, p.E!), 0, 1e-9);
    // E 比 A 更远离 C ⇒ 在 A 之外
    expect(dist(p.C!, p.E!)).toBeGreaterThan(dist(p.C!, p.A!));
  });
  it('AE = 15/13（可据此核对第 (2) 问）', () => {
    near(dist(p.A!, p.E!), 15 / 13, 1e-9);
  });
});

describe('S2 △ABC，AB=10，BC=34，cos∠ABC=3/5', () => {
  const p = pts(S2_FIG);
  it('边长与夹角符合题设', () => {
    near(dist(p.A!, p.B!), 10);
    near(dist(p.B!, p.C!), 34);
    near(Math.cos((angle(p.B!, p.A!, p.C!) * Math.PI) / 180), 3 / 5, 1e-12);
  });
  it('CM 与 AB 平行', () => {
    const ab = [p.A![0] - p.B![0], p.A![1] - p.B![1]];
    const cm = [p.M![0] - p.C![0], p.M![1] - p.C![1]];
    near(ab[0]! * cm[1]! - ab[1]! * cm[0]!, 0, 1e-9);
  });
});

describe('S4 四边形 ABCD，AD∥BC，∠A=∠B=90°', () => {
  const p = pts(S4_FIG);
  it('给定边长正确', () => {
    near(dist(p.A!, p.D!), 16);
    near(dist(p.A!, p.B!), 6);
    near(dist(p.B!, p.C!), 24);
  });
  it('两个直角与平行关系成立', () => {
    near(angle(p.A!, p.B!, p.D!), 90);
    near(angle(p.B!, p.A!, p.C!), 90);
    const ad = [p.D![0] - p.A![0], p.D![1] - p.A![1]];
    const bc = [p.C![0] - p.B![0], p.C![1] - p.B![1]];
    near(ad[0]! * bc[1]! - ad[1]! * bc[0]!, 0);
  });
  it('CD = 10（第 (1) 问）', () => {
    near(dist(p.C!, p.D!), 10);
  });
});

describe('S7 正方形 ABCD，图1 中 E 与 C 重合', () => {
  const p = pts(S7_FIG);
  it('ABCD 是正方形', () => {
    const s = dist(p.A!, p.B!);
    near(dist(p.B!, p.C!), s);
    near(dist(p.C!, p.D!), s);
    near(dist(p.D!, p.A!), s);
    near(angle(p.B!, p.A!, p.C!), 90);
  });
  it('BF=FE=AG，且 F 为 BC 中点（E 与 C 重合时）', () => {
    near(dist(p.B!, p.F!), dist(p.F!, p.C!));
    near(dist(p.A!, p.G!), dist(p.B!, p.F!));
  });
  it('P 在 GF 与 DC 两条延长线上，∠P=45°（第 (1) 问）', () => {
    near(collinear(p.G!, p.F!, p.P!), 0);
    near(collinear(p.D!, p.C!, p.P!), 0);
    near(angle(p.P!, p.G!, p.D!), 45);
  });
});

describe('S8 图1 Rt△ABC，∠ACB=90°，AB=10，BC=6', () => {
  const p = pts(S8_FIG);
  it('三边与直角符合题设，AC=8', () => {
    near(dist(p.A!, p.B!), 10);
    near(dist(p.B!, p.C!), 6);
    near(dist(p.A!, p.C!), 8);
    near(angle(p.C!, p.A!, p.B!), 90);
  });
  it('D、E 分别是 AB、AC 的中点，DE 为中位线', () => {
    near(dist(p.A!, p.D!), dist(p.D!, p.B!));
    near(dist(p.A!, p.E!), dist(p.E!, p.C!));
    near(dist(p.D!, p.E!), dist(p.B!, p.C!) / 2);
  });
});

describe('T1 等边△ABC，AE=CD，AD∩BE=F', () => {
  const p = pts(T1_FIG);
  it('△ABC 是等边三角形', () => {
    const s = dist(p.A!, p.B!);
    near(dist(p.B!, p.C!), s, 1e-9);
    near(dist(p.C!, p.A!), s, 1e-9);
  });
  it('E 在 AC 上、D 在 BC 上，且 AE=CD', () => {
    near(collinear(p.A!, p.C!, p.E!), 0, 1e-9);
    near(collinear(p.B!, p.C!, p.D!), 0, 1e-9);
    near(dist(p.A!, p.E!), dist(p.C!, p.D!), 1e-9);
  });
  it('F 是 AD 与 BE 的交点', () => {
    near(collinear(p.A!, p.D!, p.F!), 0, 1e-9);
    near(collinear(p.B!, p.E!, p.F!), 0, 1e-9);
  });
  it('AD=BE 且 ∠BFD=60°（第 (1) 问的两个结论，可直接量出来验证）', () => {
    near(dist(p.A!, p.D!), dist(p.B!, p.E!), 1e-9);
    near(angle(p.F!, p.B!, p.D!), 60, 1e-9);
  });
});

describe('T2 四边形 ABCD，AD∥BC，AD=CD', () => {
  const p = pts(T2_FIG);
  it('AD∥BC 且 AD=CD', () => {
    const ad = [p.D![0] - p.A![0], p.D![1] - p.A![1]];
    const bc = [p.C![0] - p.B![0], p.C![1] - p.B![1]];
    near(ad[0]! * bc[1]! - ad[1]! * bc[0]!, 0, 1e-9);
    near(dist(p.A!, p.D!), dist(p.C!, p.D!), 1e-9);
  });
  it('∠DAC=∠ABC 且 ∠DCA=∠BAC', () => {
    near(angle(p.A!, p.D!, p.C!), angle(p.B!, p.A!, p.C!), 1e-9);
    near(angle(p.C!, p.D!, p.A!), angle(p.A!, p.B!, p.C!), 1e-9);
  });
  it('△ABC 是等边三角形（第 (1) 问要证的结论）', () => {
    const s = dist(p.A!, p.B!);
    near(dist(p.B!, p.C!), s, 1e-9);
    near(dist(p.C!, p.A!), s, 1e-9);
  });
});

describe('T3 △ABC 与 △BDE 均为等腰直角，D、E、C 共线', () => {
  const p = pts(T3_FIG);
  it('△ABC：AB=AC 且 ∠BAC=90°', () => {
    near(dist(p.A!, p.B!), dist(p.A!, p.C!), 1e-9);
    near(angle(p.A!, p.B!, p.C!), 90, 1e-9);
  });
  it('△BDE：DB=DE=2 且 ∠BDE=90°', () => {
    near(dist(p.D!, p.B!), 2, 1e-9);
    near(dist(p.D!, p.E!), 2, 1e-9);
    near(angle(p.D!, p.B!, p.E!), 90, 1e-9);
  });
  it('D、E、C 共线', () => {
    near(collinear(p.D!, p.E!, p.C!), 0, 1e-9);
  });
  it('∠DBE = 3∠EBC（题给条件）', () => {
    near(angle(p.B!, p.D!, p.E!), 3 * angle(p.B!, p.E!, p.C!), 1e-9);
  });
  it('AC = 2√2（第 (1) 问）', () => {
    near(dist(p.A!, p.C!), 2 * Math.SQRT2, 1e-9);
  });
});

describe('T9 锐角△ABC，AB=BC=5，面积 10', () => {
  const p = pts(T9_FIG);
  it('AB=BC=5', () => {
    near(dist(p.A!, p.B!), 5);
    near(dist(p.B!, p.C!), 5);
  });
  it('面积为 10，故 BC 边上的高为 4（第 (1) 问）', () => {
    const area = Math.abs((p.C![0] - p.B![0]) * (p.A![1] - p.B![1]) - (p.A![0] - p.B![0]) * (p.C![1] - p.B![1])) / 2;
    near(area, 10);
    near((2 * area) / dist(p.B!, p.C!), 4);
  });
  it('三个角都是锐角（题设"锐角三角形"）', () => {
    for (const [v, a, b] of [
      ['A', 'B', 'C'],
      ['B', 'A', 'C'],
      ['C', 'A', 'B'],
    ] as const) {
      expect(angle(p[v]!, p[a]!, p[b]!)).toBeLessThan(90);
    }
  });
});

describe('T10 八字模型：AB、CD 交于 O', () => {
  const p = pts(T10_FIG);
  it('O 同时在 AB 和 CD 上', () => {
    near(collinear(p.A!, p.B!, p.O!), 0);
    near(collinear(p.C!, p.D!, p.O!), 0);
  });
  it('∠A+∠D = ∠B+∠C（第 (1) 问要说明的结论）', () => {
    const sum1 = angle(p.A!, p.O!, p.D!) + angle(p.D!, p.O!, p.A!);
    const sum2 = angle(p.B!, p.O!, p.C!) + angle(p.C!, p.O!, p.B!);
    near(sum1, sum2, 1e-9);
  });
});

describe('S3 矩形折叠，AB=5，AD=3，F 落在 CD 上', () => {
  const p = pts(S3_FIG);
  it('矩形边长正确', () => {
    near(dist(p.A!, p.B!), 5);
    near(dist(p.A!, p.D!), 3);
  });
  it('AF=AB=5 且 F 在 CD 上 ⇒ FC=1', () => {
    near(dist(p.A!, p.F!), 5);
    near(collinear(p.D!, p.C!, p.F!), 0);
    near(dist(p.F!, p.C!), 1);
  });
  it('折叠等量 EF=EB ⇒ BE=5/3（第 (1) 问）', () => {
    near(dist(p.E!, p.F!), dist(p.E!, p.B!), 1e-9);
    near(dist(p.B!, p.E!), 5 / 3, 1e-9);
  });
  it('B 关于折痕 AE 的对称点正好是 F', () => {
    const [ax, ay] = p.A!;
    const dx = p.E![0] - ax;
    const dy = p.E![1] - ay;
    const t = ((p.B![0] - ax) * dx + (p.B![1] - ay) * dy) / (dx * dx + dy * dy);
    const refl: P = [ax + 2 * t * dx - (p.B![0] - ax), ay + 2 * t * dy - (p.B![1] - ay)];
    near(dist(refl, p.F!), 0, 1e-9);
  });
});

describe('S6 Rt△ABC，∠A=90°，AB=2，tanC=1/2', () => {
  const p = pts(S6_FIG);
  it('直角与边长符合题设，AC=4', () => {
    near(angle(p.A!, p.B!, p.C!), 90);
    near(dist(p.A!, p.B!), 2);
    near(dist(p.A!, p.C!), 4);
  });
  it('tanC = AB/AC = 1/2', () => {
    near(dist(p.A!, p.B!) / dist(p.A!, p.C!), 0.5);
  });
  it('BC = 2√5', () => {
    near(dist(p.B!, p.C!), 2 * Math.sqrt(5), 1e-9);
  });
});

describe('T8 二次函数 y=x²+bx+c 过 C(0,−4)、D(2,−6)', () => {
  const p = pts(T8_FIG);
  const f = (x: number) => x * x - 3 * x - 4;
  it('C、D 都在图象上（据此定出 b=−3、c=−4）', () => {
    near(f(p.C![0]), p.C![1]);
    near(f(p.D![0]), p.D![1]);
  });
  it('A、B 是与 x 轴的交点，且 A 在 B 左边', () => {
    near(f(p.A![0]), 0);
    near(f(p.B![0]), 0);
    expect(p.A![0]).toBeLessThan(p.B![0]);
    near(p.A![1], 0);
    near(p.B![1], 0);
  });
  it('G 与 D 关于原点对称，且 G 在图象上（第 (1) 问）', () => {
    near(p.G![0], -p.D![0]);
    near(p.G![1], -p.D![1]);
    near(f(p.G![0]), p.G![1]);
  });
  it('抛物线采样点确实落在 y=x²−3x−4 上', () => {
    for (const [x, y] of T8_FIG.curves!.at(-1)!.points) near(f(x), y, 1e-9);
  });
});

describe('图形构建器', () => {
  const all = { S1_FIG, S2_FIG, S3_FIG, S4_FIG, S6_FIG, S7_FIG, S8_FIG, T1_FIG, T2_FIG, T3_FIG, T8_FIG, T9_FIG, T10_FIG };

  it('每张图都能构建出图元，且边的端点都在 pts 里', () => {
    for (const [name, spec] of Object.entries(all)) {
      const shapes = buildFigure(spec, { x: 0, y: 0 });
      expect(shapes.length, name).toBeGreaterThan(3);
      // buildFigure 遇到未定义的点会抛错，能跑到这里就说明引用都合法
      expect(shapes.every((s) => s.type !== undefined), name).toBe(true);
    }
  });

  it('生成的坐标都是有限数 —— NaN 会让 resvg 和 Konva 一起出问题', () => {
    for (const [name, spec] of Object.entries(all)) {
      for (const s of buildFigure(spec, { x: 500, y: 400 })) {
        const nums = [s.x, s.y, s.w, s.h, ...(s.points ?? []).flat()].filter((n) => n !== undefined);
        expect(nums.every((n) => Number.isFinite(n)), `${name} / ${s.type}`).toBe(true);
      }
    }
  });
});
