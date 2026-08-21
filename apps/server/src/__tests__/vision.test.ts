import { describe, expect, it, vi } from 'vitest';
import { detectProtocol } from '../vision.ts';

/**
 * 国内常见的两类视觉端点协议不同，配错了只会得到一个 4xx，
 * 而错误信息往往看不出是协议不对。这里把判断规则钉住。
 */
describe('视觉端点协议判断', () => {
  it('火山方舟 Agent Plan 走 Anthropic 协议', () => {
    expect(detectProtocol('https://ark.cn-beijing.volces.com/api/plan')).toBe('anthropic');
    expect(detectProtocol('https://ark.cn-beijing.volces.com/api/plan/')).toBe('anthropic');
  });

  it('火山方舟普通 API 走 OpenAI 协议', () => {
    expect(detectProtocol('https://ark.cn-beijing.volces.com/api/v3')).toBe('openai');
  });

  it('Anthropic 官方端点', () => {
    expect(detectProtocol('https://api.anthropic.com')).toBe('anthropic');
  });

  it('其他 OpenAI 兼容端点', () => {
    expect(detectProtocol('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('openai');
    expect(detectProtocol('https://open.bigmodel.cn/api/paas/v4')).toBe('openai');
  });

  it('显式指定时以配置为准', () => {
    expect(detectProtocol('https://ark.cn-beijing.volces.com/api/plan', 'openai')).toBe('openai');
    expect(detectProtocol('https://api.openai.com/v1', 'anthropic')).toBe('anthropic');
    expect(detectProtocol('https://api.openai.com/v1', '乱填')).toBe('openai'); // 无效值忽略
  });
});

/**
 * Kimi K3 的请求体形状。
 *
 * 官方文档特别强调了一条：`message.content` 必须是数组对象，
 * **不能把 JSON 数组序列化成字符串**。序列化了不会报错，
 * 模型只会当成一段普通文字，看不到图——表现是"它答得头头是道但完全没看图"。
 * 所以这里把真实发出去的请求体钉住。
 */
describe('Kimi K3 请求体', () => {
  it('走 OpenAI 分支，图以 data URI 放进 image_url 内容块', async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    vi.stubGlobal('fetch', async (url: unknown, init: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '看到一个三角形' } }] }), {
        status: 200,
      });
    });

    vi.resetModules();
    process.env.VLM_BASE_URL = 'https://api.moonshot.ai/v1';
    process.env.VLM_API_KEY = 'sk-test';
    process.env.VLM_MODEL = 'kimi-k3';
    const { makeVisionProvider } = await import('../vision.ts');

    const out = await makeVisionProvider().describe(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), '这是什么？');
    expect(out).toBe('看到一个三角形');

    const s = sent!;
    expect(s.url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(s.body.model).toBe('kimi-k3');

    const content = (s.body.messages as Array<{ content: unknown }>)[0]!.content;
    // 关键：是数组，不是被序列化成字符串
    expect(Array.isArray(content)).toBe(true);

    const blocks = content as Array<{ type: string; image_url?: { url: string } }>;
    const img = blocks.find((b) => b.type === 'image_url');
    expect(img?.image_url?.url).toMatch(/^data:image\/png;base64,/);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);

    vi.unstubAllGlobals();
    for (const k of ['VLM_BASE_URL', 'VLM_API_KEY', 'VLM_MODEL']) delete process.env[k];
  });
});
