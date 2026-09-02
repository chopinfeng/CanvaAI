import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekClient } from '../model/deepseek.js';

/**
 * 真机录像复现过：辅导一道微分方程讲到系数匹配那步，思维链把默认的
 * 4096 花光了，模型"没有工具调用也没有正文"——表现成卡住，一场里
 * 发生了 5 次，其中一次连着好几轮都翻不过去，直到录像脚本自己 20
 * 分钟的外部兜底把整场辅导硬掐断。跟 vlm.maxTokens 是同一个坑，
 * 这里补上同样的口子：可配置、默认值给得比原来的 4096 宽。
 */

function sseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) void _;
}

describe('单次回复的 token 上限', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('没配置时，默认值比 4096 宽——不能让思维链一言不合就把嘴捂上', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new DeepSeekClient({ apiKey: 'k' });
    await drain(client.stream({ messages: [{ role: 'user', content: '讲讲' }] }));

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.max_tokens).toBeGreaterThan(4096);
  });

  it('配置了 maxTokens 就照着用，不是又一个写死的数字', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new DeepSeekClient({ apiKey: 'k', maxTokens: 16000 });
    await drain(client.stream({ messages: [{ role: 'user', content: '讲讲' }] }));

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.max_tokens).toBe(16000);
  });
});
