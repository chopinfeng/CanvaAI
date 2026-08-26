import { describe, expect, it } from 'vitest';
import type { Shape } from '@canvai/protocol';
import { ShapeSchema } from '@canvai/protocol';
import { sceneToSvg } from '../svg.js';

const mk = (over: Partial<Shape> & Pick<Shape, 'id' | 'type' | 'x' | 'y'>): Shape =>
  ShapeSchema.parse({
    layer: 'ai',
    author: { id: 'ai1', kind: 'ai' },
    opId: 'op_1',
    rotation: 0,
    z: 1,
    style: {},
    meta: {},
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

describe('sceneToSvg: latex shape', () => {
  it('渲染出排好版的公式，不是带反斜杠的原始 LaTeX 字面量', () => {
    const s = mk({ id: 'sh_1', type: 'latex', x: 10, y: 10, text: 'L(x,y,\\lambda) = x^2 + y^2' });
    const svg = sceneToSvg([s]);
    expect(svg).not.toContain('\\lambda');
    expect(svg).not.toContain('x^2');
    // 内嵌的公式应该是自洽的矢量路径，不依赖外部字体
    expect(svg).toContain('<path');
  });

  it('公式按 shape.style.stroke 上色', () => {
    const s = mk({ id: 'sh_2', type: 'latex', x: 0, y: 0, text: 'x', style: { stroke: '#ff0000' } });
    const svg = sceneToSvg([s]);
    expect(svg).toContain('color="#ff0000"');
  });

  it('语法错误的公式退化成纯文本而不是让图元消失', () => {
    const s = mk({ id: 'sh_3', type: 'latex', x: 0, y: 0, text: '' });
    const svg = sceneToSvg([s]);
    expect(svg).toContain('<text');
  });

  it('MathJax 自己排不出来的公式（noerrors 兜底出的错误框）也退化成纯文本', () => {
    const s = mk({ id: 'sh_4', type: 'latex', x: 0, y: 0, text: '\\frac{1' });
    const svg = sceneToSvg([s]);
    expect(svg).toContain('<text');
    expect(svg).toContain('\\frac{1');
  });
});
