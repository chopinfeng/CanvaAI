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
