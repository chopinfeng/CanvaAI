import { describe, expect, it } from 'vitest';
import { resolveFill } from '../shapeFill';

/**
 * 真机录像复现过："给答案画个框"变成了"把答案涂黑擦掉"——AI 正确地传了
 * fill:'none'，但 Konva 底层是 Canvas 2D 的 fillStyle，只认得真正的
 * 颜色值；赋值一个解析不了的字符串会静默失败，fillStyle 停留在画布
 * 默认色——黑色，把框住的文字整个盖住了。
 */
describe('resolveFill —— fill:"none" 不能原样喂给 Konva', () => {
  it('"none" 转成 undefined，Konva 才会真的不填充', () => {
    expect(resolveFill('none')).toBeUndefined();
  });

  it('"transparent" 同样转成 undefined', () => {
    expect(resolveFill('transparent')).toBeUndefined();
  });

  it('没设置 fill 时保持 undefined', () => {
    expect(resolveFill(undefined)).toBeUndefined();
  });

  it('真正的颜色值原样传出', () => {
    expect(resolveFill('#FF0000')).toBe('#FF0000');
    expect(resolveFill('red')).toBe('red');
  });
});
