import { describe, expect, it } from 'vitest';
import { isLatexError, renderLatexToSvg } from '../latex.js';

describe('renderLatexToSvg', () => {
  it('渲染出自洽的 SVG，不留 LaTeX 反斜杠/花括号字面量', () => {
    const r = renderLatexToSvg('L(x,y,\\lambda) = x^2 + y^2 - \\lambda(x + 2y - 5)');
    expect(isLatexError(r)).toBe(false);
    if (isLatexError(r)) return;
    expect(r.svg).toMatch(/^<svg /);
    expect(r.svg).not.toContain('\\lambda');
    expect(r.svg).not.toContain('\\');
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });

  it('没有外部字体/CSS 依赖 —— 内容自洽，可以直接内嵌或转成 data URI', () => {
    const r = renderLatexToSvg('x^2');
    expect(isLatexError(r)).toBe(false);
    if (isLatexError(r)) return;
    expect(r.svg).not.toContain('<use');
    expect(r.svg).not.toContain('font-family');
    expect(r.svg).not.toMatch(/href="(?!#)/);
  });

  it('width/height 已经换算成 px，且随 fontSize 等比缩放', () => {
    const small = renderLatexToSvg('x^2 + y^2', 16);
    const big = renderLatexToSvg('x^2 + y^2', 32);
    expect(isLatexError(small)).toBe(false);
    expect(isLatexError(big)).toBe(false);
    if (isLatexError(small) || isLatexError(big)) return;
    expect(big.width).toBeCloseTo(small.width * 2, 0);
    expect(big.height).toBeCloseTo(small.height * 2, 0);
  });

  it('空字符串报错而不是渲染出空图', () => {
    const r = renderLatexToSvg('   ');
    expect(isLatexError(r)).toBe(true);
  });

  it('语法错误不抛异常，报成我们自己的错误状态（而不是画一个看不清内容的色块）', () => {
    expect(() => renderLatexToSvg('\\frac{1')).not.toThrow();
    const r = renderLatexToSvg('\\frac{1');
    expect(isLatexError(r)).toBe(true);
  });
});
