import { describe, expect, it } from 'vitest';
import { Scene } from '@canvai/canvas-core';
import { extractLeakedCalls, hasLeakedCalls } from '../model/leaked-calls.js';
import { decodeDoubleEncoded } from '../tools/registry.js';
import { USER, call, makeHarness } from './harness.js';

/**
 * 两个实测踩到的模型行为怪癖。都不是"模型笨"，是接口没接住。
 */

describe('参数双重编码', () => {
  it('把套成 JSON 字符串的对象还原回来', () => {
    expect(decodeDoubleEncoded({ a: '{"x": 460, "y": 380}', what: 'distance' })).toEqual({
      a: { x: 460, y: 380 },
      what: 'distance',
    });
  });

  it('普通文本原样保留，不会被当成 JSON 拆掉', () => {
    const text = '看图上我标红的这条 EF —— 它是斜边';
    expect(decodeDoubleEncoded({ text })).toEqual({ text });
    expect(decodeDoubleEncoded({ text: '答案是 {5/3}' })).toEqual({ text: '答案是 {5/3}' });
  });

  it('数组与嵌套结构都能还原', () => {
    expect(decodeDoubleEncoded({ shapes: '[{"type":"rect"}]' })).toEqual({ shapes: [{ type: 'rect' }] });
    expect(decodeDoubleEncoded({ a: { b: '{"c": 1}' } })).toEqual({ a: { b: { c: 1 } } });
  });

  it('真正的图元 id 不受影响', () => {
    expect(decodeDoubleEncoded({ a: 'sh_abc123', what: 'length' })).toEqual({ a: 'sh_abc123', what: 'length' });
  });

  it('端到端：双重编码的坐标点也能量出距离', async () => {
    const scene = new Scene();
    const h = makeHarness(
      [
        {
          calls: [
            // 模型实际发出来的就是这个样子：对象被套进了字符串
            {
              id: 'c1',
              type: 'function' as const,
              function: {
                name: 'canvas_measure',
                arguments: '{"a": "{\\"x\\": 0, \\"y\\": 0}", "b": "{\\"x\\": 3, \\"y\\": 4}", "what": "distance"}',
              },
            },
          ],
        },
        { text: '量好了' },
      ],
      { scene },
    );
    h.loop.push({ kind: 'text', text: '量一下', at: Date.now() });
    await h.loop.drain();

    const payload = JSON.parse(h.loop.getHistory().find((m) => m.role === 'tool')!.content as string);
    expect(payload.ok).toBe(true);
    expect(payload.data.distance).toBe(5);
  });

  it('传了不存在的 id 时，提示指向"别把对象写成字符串"', async () => {
    const h = makeHarness([{ calls: [call('canvas_measure', { a: '{"x":1,"y":2}', what: 'area' })] }, { text: 'ok' }]);
    // 注意：这里 args 本身是合法 JSON 字符串，会被还原成对象；
    // 换成一个还原不了的字符串来触发提示
    void h;

    const h2 = makeHarness([{ calls: [call('canvas_measure', { a: '{不是合法JSON', what: 'area' })] }, { text: 'ok' }]);
    h2.loop.push({ kind: 'text', text: '量面积', at: Date.now() });
    await h2.loop.drain();

    const payload = JSON.parse(h2.loop.getHistory().find((m) => m.role === 'tool')!.content as string);
    expect(payload.ok).toBe(false);
    expect(payload.hint).toContain('不要再套一层引号');
  });
});

describe('工具调用漏成正文', () => {
  const LEAKED =
    '<｜｜DSML｜｜tool_calls>\n' +
    '<｜｜DSML｜｜invoke name="interact_say">\n' +
    '<｜｜DSML｜｜parameter name="text" string="true">EF 才是斜边，你把方向搞反了。</｜｜DSML｜｜parameter>\n' +
    '</｜｜DSML｜｜invoke>\n' +
    '</｜｜DSML｜｜tool_calls>';

  it('认得出这类标记', () => {
    expect(hasLeakedCalls(LEAKED)).toBe(true);
    expect(hasLeakedCalls('普通回答，不含标记')).toBe(false);
  });

  it('还原成真正的工具调用，并把标记从正文里剔掉', () => {
    const r = extractLeakedCalls(LEAKED);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.function.name).toBe('interact_say');
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ text: 'EF 才是斜边，你把方向搞反了。' });
    expect(r.text).toBe('');
    expect(r.unparsed).toBe(false);
  });

  it('正文里的其他内容保留下来', () => {
    const r = extractLeakedCalls(`先说一句。\n${LEAKED}\n再说一句。`);
    expect(r.text).toContain('先说一句');
    expect(r.text).toContain('再说一句');
    expect(r.text).not.toContain('DSML');
  });

  it('ASCII 竖线的变体也能认', () => {
    const ascii = LEAKED.replace(/｜/g, '|');
    expect(extractLeakedCalls(ascii).calls).toHaveLength(1);
  });

  it('解析不出来时，至少不把标记露给用户', () => {
    const broken = '<｜｜DSML｜｜tool_calls>\n乱七八糟的内容\n</｜｜DSML｜｜tool_calls>';
    const r = extractLeakedCalls(broken);
    expect(r.calls).toHaveLength(0);
    expect(r.unparsed).toBe(true);
    expect(r.text).not.toContain('DSML');
  });

  it('端到端：漏成正文的 interact_say 会被真正执行', async () => {
    const h = makeHarness([{ text: LEAKED }, { text: '讲完了' }]);
    h.loop.push({ kind: 'text', text: '讲讲', at: Date.now() });
    await h.loop.drain();

    const said = h.events('agent.say');
    expect(said).toHaveLength(1);
    expect(said[0]!.text).toBe('EF 才是斜边，你把方向搞反了。');
  });

  it('端到端：解析不出来时提醒模型改走正规通道', async () => {
    const h = makeHarness([{ text: '<｜｜DSML｜｜tool_calls>\n坏掉的\n</｜｜DSML｜｜tool_calls>' }, { text: '重来' }]);
    h.loop.push({ kind: 'text', text: '讲讲', at: Date.now() });
    await h.loop.drain();

    const nudge = h.loop
      .getHistory()
      .find((m) => m.role === 'user' && String(m.content).includes('function calling'));
    expect(nudge).toBeDefined();

    // 用户那边看不到任何标记残留
    const assistantText = h.loop.getHistory().filter((m) => m.role === 'assistant').map((m) => m.content).join('');
    expect(assistantText).not.toContain('DSML');
  });
});

export { USER };
