import { describe, expect, it } from 'vitest';
import { compatSchema, mergeToolCallDeltas } from '../model/deepseek.js';

/**
 * 这条是真机踩出来的。
 *
 * 换到 OpenRouter 上的 stealth/ox-alpha 之后，学生 Agent 第一条请求就 400，
 * 上游只回一句 "Provider returned error"，不说是哪个字段。二分到最后是
 * student_look.region 的元组式 items——DeepSeek 收，这家不收。
 *
 * 没有这几条测试的话，下次谁"顺手简化一下 schema"把元组式写回来，
 * 会在换端点的那天才炸，而那天没人会想到是这里。
 */
describe('工具 schema 的端点兼容规整', () => {
  it('元组式 items 摊平成单 schema，长度约束留着', () => {
    const got = compatSchema({
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: [{ type: 'number' }, { type: 'number' }, { type: 'number' }, { type: 'number' }],
    }) as Record<string, unknown>;
    expect(got.items).toEqual({ type: 'number' });
    expect(got.minItems).toBe(4);
    expect(got.maxItems).toBe(4);
  });

  it('元素类型不一致时放宽成任意，而不是瞎挑第一个', () => {
    const got = compatSchema({
      type: 'array',
      items: [{ type: 'number' }, { type: 'string' }],
    }) as Record<string, unknown>;
    expect(got.items).toEqual({});
  });

  it('嵌套在深处的也要规整——points 是数组的数组', () => {
    const got = compatSchema({
      type: 'object',
      properties: {
        shapes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              points: { type: 'array', items: { type: 'array', items: [{ type: 'number' }, { type: 'number' }] } },
            },
          },
        },
      },
    }) as any;
    expect(got.properties.shapes.items.properties.points.items.items).toEqual({ type: 'number' });
  });

  it('本来就合规的 schema 原样不动', () => {
    const src = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
    expect(compatSchema(src)).toEqual(src);
  });

  it('required / enum 这些数组值不能被当成 items 误伤', () => {
    const got = compatSchema({
      type: 'object',
      required: ['a', 'b'],
      properties: { t: { type: 'string', enum: ['rect', 'line'] } },
    }) as any;
    expect(got.required).toEqual(['a', 'b']);
    expect(got.properties.t.enum).toEqual(['rect', 'line']);
  });
});

/**
 * 同一轮里的两个工具调用，stealth/ox-alpha **都标 index 0**。
 *
 * 只按 index 拼的话，第二个调用的 arguments 会接到第一个后面，
 * 拼成 `{"limit":30}{"detail":"full",…}`——不是合法 JSON，整轮工具一个都不执行。
 * 表面症状是"模型产出了一千多个 token，然后什么都没发生"，日志里连报错都没有，
 * 查起来极其费劲。这几条测试是为了别再查第二次。
 */
describe('工具调用分片拼接', () => {
  it('index 相同但 id 不同 = 两个调用，不能拼到一起', () => {
    const got = mergeToolCallDeltas([
      [{ index: 0, id: 'a', type: 'function', function: { name: 'canvas_query', arguments: '' } }],
      [{ index: 0, function: { arguments: '{"limit":30}' } }],
      [{ index: 0, id: 'b', type: 'function', function: { name: 'canvas_describe', arguments: '' } }],
      [{ index: 0, function: { arguments: '{"detail":"full"}' } }],
    ]);
    expect(got.map((c) => c.function.name)).toEqual(['canvas_query', 'canvas_describe']);
    expect(got.map((c) => c.function.arguments)).toEqual(['{"limit":30}', '{"detail":"full"}']);
    for (const c of got) expect(() => JSON.parse(c.function.arguments)).not.toThrow();
  });

  it('规规矩矩用不同 index 的（DeepSeek 的做法）照样拼对', () => {
    const got = mergeToolCallDeltas([
      [{ index: 0, id: 'a', type: 'function', function: { name: 'x', arguments: '{"a"' } }],
      [{ index: 1, id: 'b', type: 'function', function: { name: 'y', arguments: '{"b"' } }],
      [{ index: 0, function: { arguments: ':1}' } }],
      [{ index: 1, function: { arguments: ':2}' } }],
    ]);
    expect(got.map((c) => [c.function.name, c.function.arguments])).toEqual([
      ['x', '{"a":1}'],
      ['y', '{"b":2}'],
    ]);
  });

  it('函数名本身也可能被切成几片', () => {
    const got = mergeToolCallDeltas([
      [{ index: 0, id: 'a', type: 'function', function: { name: 'canvas_', arguments: '' } }],
      [{ index: 0, function: { name: 'query', arguments: '{}' } }],
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]!.function.name).toBe('canvas_query');
  });
});
