import { describe, expect, it } from 'vitest';
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
