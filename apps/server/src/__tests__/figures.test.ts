import { describe, expect, it } from 'vitest';
import * as F from '../../scripts/figures.ts';
import { buildFigure, type FigureSpec } from '../../scripts/figure.ts';
import { PROBLEMS } from '../../scripts/problems.ts';

/**
 * 题目和图形都是自编的，所以更要验：坐标必须由题给条件推得出来，
 * 而不是"看着差不多"。凭感觉摆的图会被 Agent 当真去测量，
 * 得出的数是错的——那比没有图更糟。
 */

type P = readonly [number, number];
const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const angle = (v: P, a: P, b: P) => {
  const u1: P = [a[0] - v[0], a[1] - v[1]];
  const u2: P = [b[0] - v[0], b[1] - v[1]];
  const cos = (u1[0] * u2[0] + u1[1] * u2[1]) / (Math.hypot(...u1) * Math.hypot(...u2));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
};
const collinear = (a: P, b: P, c: P) =>
  Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
const area = (a: P, b: P, c: P) =>
  Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
const pts = (f: FigureSpec) => f.pts as Record<string, P>;
const near = (v: number, t: number, tol = 1e-9) => expect(Math.abs(v - t)).toBeLessThan(tol);

describe('G1 矩形折叠 AB=13，AD=5', () => {
  const p = pts(F.G1_FIG);
  it('矩形边长正确', () => {
    near(dist(p.A!, p.B!), 13);
    near(dist(p.A!, p.D!), 5);
  });
  it('AF=AB=13 且 F 在 CD 上 ⇒ DF=12、FC=1', () => {
    near(dist(p.A!, p.F!), 13);
    near(collinear(p.D!, p.C!, p.F!), 0);
    near(dist(p.D!, p.F!), 12);
    near(dist(p.F!, p.C!), 1);
  });
  it('折叠等量 EF=EB ⇒ BE=13/5', () => {
    near(dist(p.E!, p.F!), dist(p.E!, p.B!), 1e-9);
    near(dist(p.B!, p.E!), 13 / 5, 1e-9);
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

describe('G2 等腰△ABC，AB=AC=13，BC=10', () => {
  const p = pts(F.G2_FIG);
  it('三边符合题设，高为 12', () => {
    near(dist(p.A!, p.B!), 13);
    near(dist(p.A!, p.C!), 13);
    near(dist(p.B!, p.C!), 10);
    near(dist(p.A!, p.H!), 12);
  });
  it('面积为 60', () => near(area(p.A!, p.B!, p.C!), 60));
  it('内切圆半径 r=S/s=10/3，圆心在高上且到 BC 距离等于 r', () => {
    const s = (13 + 13 + 10) / 2;
    near(60 / s, 10 / 3, 1e-9);
    near(p.I![0], 0);
    near(p.I![1], 10 / 3, 1e-9); // 到 BC（y=0）的距离即为 r
  });
});

describe('G3 直角梯形 AD=9，AB=8，BC=15', () => {
  const p = pts(F.G3_FIG);
  it('给定边长与两个直角', () => {
    near(dist(p.A!, p.D!), 9);
    near(dist(p.A!, p.B!), 8);
    near(dist(p.B!, p.C!), 15);
    near(angle(p.A!, p.B!, p.D!), 90);
    near(angle(p.B!, p.A!, p.C!), 90);
  });
  it('AD∥BC', () => {
    const ad: P = [p.D![0] - p.A![0], p.D![1] - p.A![1]];
    const bc: P = [p.C![0] - p.B![0], p.C![1] - p.B![1]];
    near(ad[0] * bc[1] - ad[1] * bc[0], 0);
  });
  it('CD=10（第 1 问），面积=96（第 2 问）', () => {
    near(dist(p.C!, p.D!), 10);
    near(((9 + 15) * 8) / 2, 96);
  });
});

describe('G4 Rt△ABC，∠C=90°，AC=12，BC=5', () => {
  const p = pts(F.G4_FIG);
  it('三边与直角，AB=13', () => {
    near(dist(p.A!, p.C!), 12);
    near(dist(p.B!, p.C!), 5);
    near(dist(p.A!, p.B!), 13);
    near(angle(p.C!, p.A!, p.B!), 90);
  });
  it('D、E 是中点，DE 为中位线且长 =BC/2', () => {
    near(dist(p.A!, p.D!), dist(p.D!, p.B!));
    near(dist(p.A!, p.E!), dist(p.E!, p.C!));
    near(dist(p.D!, p.E!), 2.5);
  });
});

describe('G5 等边△ABC 边长 8，AE=CD=3', () => {
  const p = pts(F.G5_FIG);
  it('等边三角形', () => {
    const s = dist(p.A!, p.B!);
    near(s, 8, 1e-9);
    near(dist(p.B!, p.C!), s, 1e-9);
    near(dist(p.C!, p.A!), s, 1e-9);
  });
  it('E 在 AC 上、D 在 BC 上，AE=CD=3', () => {
    near(collinear(p.A!, p.C!, p.E!), 0, 1e-9);
    near(collinear(p.B!, p.C!, p.D!), 0, 1e-9);
    near(dist(p.A!, p.E!), 3, 1e-9);
    near(dist(p.C!, p.D!), 3, 1e-9);
  });
  it('F 是 AD 与 BE 的交点', () => {
    near(collinear(p.A!, p.D!, p.F!), 0, 1e-8);
    near(collinear(p.B!, p.E!, p.F!), 0, 1e-8);
  });
  it('AD=BE=7（第 2 问），∠BFD=60°（第 3 问）', () => {
    near(dist(p.A!, p.D!), 7, 1e-9);
    near(dist(p.B!, p.E!), 7, 1e-9);
    near(angle(p.F!, p.B!, p.D!), 60, 1e-6);
  });
});

describe('G6 Rt△ABC，∠A=90°，AB=3，tanC=3/4', () => {
  const p = pts(F.G6_FIG);
  it('直角与边长，AC=4、BC=5', () => {
    near(angle(p.A!, p.B!, p.C!), 90);
    near(dist(p.A!, p.B!), 3);
    near(dist(p.A!, p.C!), 4);
    near(dist(p.B!, p.C!), 5);
  });
  it('tanC=AB/AC=3/4，sinC=3/5，cosC=4/5', () => {
    near(dist(p.A!, p.B!) / dist(p.A!, p.C!), 3 / 4);
    near(dist(p.A!, p.B!) / dist(p.B!, p.C!), 3 / 5);
    near(dist(p.A!, p.C!) / dist(p.B!, p.C!), 4 / 5);
  });
});

describe('G7 正方形边长 4，E 为 BC 中点', () => {
  const p = pts(F.G7_FIG);
  it('是正方形', () => {
    const s = dist(p.A!, p.B!);
    near(s, 4);
    near(dist(p.B!, p.C!), s);
    near(dist(p.C!, p.D!), s);
    near(dist(p.D!, p.A!), s);
  });
  it('E 是 BC 中点', () => near(dist(p.B!, p.E!), dist(p.E!, p.C!)));
  it('AE=DE=2√5（第 1 问），tan∠AED=4/3（第 2 问）', () => {
    near(dist(p.A!, p.E!), 2 * Math.sqrt(5), 1e-9);
    near(dist(p.D!, p.E!), 2 * Math.sqrt(5), 1e-9);
    const a = (angle(p.E!, p.A!, p.D!) * Math.PI) / 180;
    near(Math.tan(a), 4 / 3, 1e-9);
  });
});

describe('G8 八字模型', () => {
  const p = pts(F.G8_FIG);
  it('O 同时在 AB 与 CD 上', () => {
    near(collinear(p.A!, p.B!, p.O!), 0);
    near(collinear(p.C!, p.D!, p.O!), 0);
  });
  it('∠A+∠D = ∠B+∠C（第 1 问）', () => {
    const s1 = angle(p.A!, p.O!, p.D!) + angle(p.D!, p.O!, p.A!);
    const s2 = angle(p.B!, p.O!, p.C!) + angle(p.C!, p.O!, p.B!);
    near(s1, s2, 1e-9);
  });
});

describe('G9 DE∥BC，AD=4，DB=2，DE=6', () => {
  const p = pts(F.G9_FIG);
  it('D 在 AB 上、E 在 AC 上', () => {
    near(collinear(p.A!, p.B!, p.D!), 0);
    near(collinear(p.A!, p.C!, p.E!), 0);
  });
  it('DE∥BC', () => {
    const de: P = [p.E![0] - p.D![0], p.E![1] - p.D![1]];
    const bc: P = [p.C![0] - p.B![0], p.C![1] - p.B![1]];
    near(de[0] * bc[1] - de[1] * bc[0], 0);
  });
  it('AD∶AB = DE∶BC = 2∶3（第 1、2 问）', () => {
    const k = dist(p.A!, p.D!) / dist(p.A!, p.B!);
    near(k, 2 / 3, 1e-9);
    near(dist(p.D!, p.E!) / dist(p.B!, p.C!), k, 1e-9);
  });
});

describe('G10 ⊙O 半径 5，弦 AB=8', () => {
  const p = pts(F.G10_FIG);
  it('A、B 都在圆上，弦长为 8', () => {
    near(dist(p.O!, p.A!), 5);
    near(dist(p.O!, p.B!), 5);
    near(dist(p.A!, p.B!), 8);
  });
  it('H 是 AB 中点，OH⊥AB，AH=4、OH=3（两问）', () => {
    near(dist(p.A!, p.H!), dist(p.H!, p.B!));
    near(dist(p.A!, p.H!), 4);
    near(angle(p.H!, p.O!, p.B!), 90);
    near(dist(p.O!, p.H!), 3);
  });
});

describe('G11 二次函数 y=x²−2x−3', () => {
  const p = pts(F.G11_FIG);
  const f = (x: number) => x * x - 2 * x - 3;
  it('与两轴的交点（第 1 问）', () => {
    near(f(p.A![0]), 0);
    near(f(p.B![0]), 0);
    near(p.A![0], -1);
    near(p.B![0], 3);
    near(p.C![1], -3);
    near(f(0), p.C![1]);
  });
  it('顶点 (1,−4)（第 2 问）', () => {
    near(p.V![0], 1);
    near(p.V![1], -4);
    near(f(1), -4);
  });
  it('采样点确实落在函数图象上', () => {
    for (const [x, y] of F.G11_FIG.curves!.at(-1)!.points) near(f(x), y, 1e-9);
  });
});

describe('G12 直线 y=−2x+6', () => {
  const p = pts(F.G12_FIG);
  it('与两轴的交点 P(3,0)、Q(0,6)（第 1 问）', () => {
    near(p.P![0], 3);
    near(p.P![1], 0);
    near(p.Q![0], 0);
    near(p.Q![1], 6);
    near(-2 * 3 + 6, 0);
  });
  it('△OPQ 面积为 9（第 2 问）', () => near(area(p.O!, p.P!, p.Q!), 9));
});

describe('题库整体', () => {
  it('20 道题，id 唯一', () => {
    expect(PROBLEMS).toHaveLength(20);
    expect(new Set(PROBLEMS.map((p) => p.id)).size).toBe(20);
  });

  it('每道题要么有图形、要么写明了为什么没有', () => {
    for (const p of PROBLEMS) {
      expect(Boolean(p.figure) || Boolean(p.figureNote), p.id).toBe(true);
    }
  });

  it('每道题都有参考答案，供辅导时校验（不展示给用户）', () => {
    for (const p of PROBLEMS) expect(p.answer, p.id).toBeTruthy();
  });

  it('所有图形都能构建，且坐标都是有限数', () => {
    for (const p of PROBLEMS) {
      if (!p.figure) continue;
      const shapes = p.figure({ x: 500, y: 400 });
      expect(shapes.length, p.id).toBeGreaterThan(3);
      for (const s of shapes) {
        const nums = [s.x, s.y, s.w, s.h, ...(s.points ?? []).flat()].filter((n) => n !== undefined);
        expect(nums.every((n) => Number.isFinite(n)), `${p.id} / ${s.type}`).toBe(true);
      }
    }
  });
});
