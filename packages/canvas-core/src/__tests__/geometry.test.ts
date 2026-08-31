import { describe, expect, it } from 'vitest';
import type { Shape } from '@canvai/protocol';
import { ShapeSchema } from '@canvai/protocol';
import {
  angleAt,
  computeRelations,
  distance,
  hitTestShape,
  polygonArea,
  pt,
  rectCrossedBySegment,
  rectDistance,
  segmentIntersection,
  shapeArea,
  shapeBounds,
} from '../geometry.js';

const mk = (over: Partial<Shape> & Pick<Shape, 'id' | 'type' | 'x' | 'y'>): Shape =>
  ShapeSchema.parse({
    layer: 'user',
    author: { id: 'u1', kind: 'user' },
    opId: 'op_1',
    rotation: 0,
    z: 1,
    style: {},
    meta: {},
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

describe('bounds', () => {
  it('矩形包围盒就是自身', () => {
    const s = mk({ id: 'a', type: 'rect', x: 10, y: 20, w: 100, h: 50 });
    expect(shapeBounds(s)).toEqual([10, 20, 100, 50]);
  });

  it('点序列图元的包围盒含半个线宽的外扩', () => {
    const s = mk({
      id: 'b',
      type: 'polygon',
      x: 0,
      y: 0,
      points: [[0, 0], [100, 0], [50, -80]],
      style: { strokeWidth: 4 },
    });
    expect(shapeBounds(s)).toEqual([-2, -82, 104, 84]);
  });

  it('旋转 90° 的矩形包围盒随之改变', () => {
    const s = mk({ id: 'c', type: 'rect', x: 0, y: 0, w: 100, h: 20, rotation: 90 });
    const [, , w, h] = shapeBounds(s);
    expect(Math.round(w)).toBe(20);
    expect(Math.round(h)).toBe(100);
  });

  /**
   * 真机复现过：一道 8 行的题干，宽度按"整段文字字符总数"估算，
   * 算出来超过 2500px，把碰撞检测的判定区域撑到了画布右侧一大片
   * 本来是空白的地方——AI 写字被这片虚假碰撞区反复拦下，答对的题
   * 卡死不动。宽度该是最长的那一行，不是每一行加总。
   */
  it('多行文字的包围盒宽度是最长的一行，不是整段文字的字符总数', () => {
    const oneLine = mk({ id: 'd', type: 'text', x: 0, y: 0, text: '短句', style: { fontSize: 16 } });
    const eightLines = mk({
      id: 'e',
      type: 'text',
      x: 0,
      y: 0,
      text: Array(8).fill('短句').join('\n'),
      style: { fontSize: 16 },
    });
    const [, , wOne] = shapeBounds(oneLine);
    const [, , wEight, hEight] = shapeBounds(eightLines);
    // 每一行内容相同，宽度不该因为多了 7 行而膨胀
    expect(wEight).toBe(wOne);
    // 高度该按行数走——这条本来就是对的，一并确认没有被改坏
    expect(hEight).toBeCloseTo(wOne > 0 ? 8 * 16 * 1.4 : 0, 1);
  });
});

/**
 * 用户直接在板书截图里看出来的问题："这次的板书又覆盖到图形上了"——
 * "图案得挨着题目图形"那道闸只查包围盒相交，逼着模型把文字写进了
 * 三角形内部，结果新文字被三角形自己的边、高线从中间划了过去。
 * 包围盒重叠判断不出这个：一条边的包围盒能盖住大半个三角形内部，
 * 但线本身只是那个盒子里的一条对角线。
 */
describe('线段有没有真的穿过一个矩形', () => {
  it('线段贴着矩形正中间划过去——算穿过', () => {
    // 矩形 [10,10,80,20]，一条从左上斜到右下、正好穿过矩形中心的线段
    expect(rectCrossedBySegment([10, 10, 80, 20], { a: pt(0, 0), b: pt(100, 100) })).toBe(true);
  });

  it('线段的包围盒盖住了矩形，但线本身没有真的划过去——不算穿过', () => {
    // 三角形一条边 B(0,100)→A(50,0) 的包围盒是 [0,0,50,100]，
    // 矩形 [30,80,15,15] 落在这个包围盒里，但离那条斜线其实还有一段距离
    expect(rectCrossedBySegment([30, 80, 15, 15], { a: pt(0, 100), b: pt(50, 0) })).toBe(false);
  });

  it('线段的端点直接落在矩形里——算穿过', () => {
    expect(rectCrossedBySegment([10, 10, 20, 20], { a: pt(15, 15), b: pt(100, 100) })).toBe(true);
  });
});

describe('测量', () => {
  it('距离', () => {
    expect(distance(pt(0, 0), pt(3, 4))).toBe(5);
  });

  it('三点夹角', () => {
    expect(angleAt(pt(1, 0), pt(0, 0), pt(0, 1))).toBeCloseTo(90);
    expect(angleAt(pt(1, 0), pt(0, 0), pt(-1, 0))).toBeCloseTo(180);
  });

  it('多边形面积用鞋带公式', () => {
    expect(polygonArea([pt(0, 0), pt(4, 0), pt(4, 3)])).toBe(6);
  });

  it('椭圆面积', () => {
    const s = mk({ id: 'e', type: 'ellipse', x: 0, y: 0, w: 40, h: 20 });
    expect(shapeArea(s)).toBeCloseTo(Math.PI * 20 * 10);
  });

  it('线段交点', () => {
    const hit = segmentIntersection(
      { a: pt(0, 0), b: pt(10, 10) },
      { a: pt(0, 10), b: pt(10, 0) },
    );
    expect(hit).toEqual(pt(5, 5));
  });

  it('平行线段无交点', () => {
    expect(segmentIntersection({ a: pt(0, 0), b: pt(10, 0) }, { a: pt(0, 5), b: pt(10, 5) })).toBeNull();
  });

  it('矩形间距，相交时为 0', () => {
    expect(rectDistance([0, 0, 10, 10], [20, 0, 10, 10])).toBe(10);
    expect(rectDistance([0, 0, 10, 10], [5, 5, 10, 10])).toBe(0);
  });
});

describe('命中测试', () => {
  it('线只在笔画附近命中，不是整个包围盒', () => {
    const line = mk({ id: 'l', type: 'line', x: 0, y: 0, points: [[0, 0], [100, 100]] });
    expect(hitTestShape(line, pt(50, 50), 4)).toBe(true);
    expect(hitTestShape(line, pt(90, 10), 4)).toBe(false); // 在包围盒里但离线很远
  });

  it('椭圆按椭圆判定而非包围盒', () => {
    const e = mk({ id: 'e', type: 'ellipse', x: 0, y: 0, w: 100, h: 100 });
    expect(hitTestShape(e, pt(50, 50), 0)).toBe(true);
    expect(hitTestShape(e, pt(5, 5), 0)).toBe(false); // 左上角在方框内、圆外
  });
});

describe('空间关系', () => {
  it('识别包含关系', () => {
    const outer = mk({ id: 'outer', type: 'rect', x: 0, y: 0, w: 200, h: 200 });
    const inner = mk({ id: 'inner', type: 'rect', x: 50, y: 50, w: 50, h: 50 });
    const rels = computeRelations([outer, inner]);
    expect(rels).toContainEqual({ a: 'outer', b: 'inner', kind: 'contains' });
  });

  it('识别「屋顶在房子上方」', () => {
    const house = mk({ id: 'house', type: 'rect', x: 100, y: 200, w: 200, h: 150 });
    const roof = mk({
      id: 'roof',
      type: 'polygon',
      x: 0,
      y: 0,
      points: [[80, 200], [200, 110], [320, 200]],
      style: { strokeWidth: 0 },
    });
    const rels = computeRelations([house, roof]);
    expect(rels.some((r) => r.a === 'roof' && r.b === 'house' && r.kind === 'above')).toBe(true);
  });

  it('识别平行与垂直', () => {
    const a = mk({ id: 'a', type: 'line', x: 0, y: 0, points: [[0, 0], [100, 0]] });
    const b = mk({ id: 'b', type: 'line', x: 0, y: 50, points: [[0, 0], [100, 0]] });
    const c = mk({ id: 'c', type: 'line', x: 300, y: 0, points: [[0, 0], [0, 100]] });
    const rels = computeRelations([a, b, c]);
    expect(rels.some((r) => r.kind === 'parallel' && r.a === 'a' && r.b === 'b')).toBe(true);
    expect(rels.some((r) => r.kind === 'perpendicular')).toBe(true);
  });
});
