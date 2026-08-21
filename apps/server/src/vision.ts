import type { VisionProvider } from '@canvai/agent';
import { config } from './config.ts';
import { log } from './log.ts';

/**
 * 视觉兜底。
 *
 * DeepSeek 是纯文本的，所以理解手绘笔触/位图时走一个独立的 VLM。
 * 支持两种协议——不是为了炫技，是因为国内常见的两类端点确实不一样：
 *
 * - openai    ：`/chat/completions` + `image_url`。Qwen-VL、GLM-4V、gpt-4o、
 *               火山方舟的 `/api/v3` 都是这套。
 * - anthropic ：`/v1/messages` + `image` 内容块（base64 source）。
 *               Claude 官方，以及火山方舟 Agent Plan 的 `/api/plan` 是这套。
 *
 * 不配 VLM_PROTOCOL 时按 base URL 猜（含 `/api/plan` 或 `anthropic` 就按后者）。
 */

export type VlmProtocol = 'openai' | 'anthropic';

export function detectProtocol(baseUrl: string, explicit?: string): VlmProtocol {
  if (explicit === 'openai' || explicit === 'anthropic') return explicit;
  return /\/api\/plan|anthropic/i.test(baseUrl) ? 'anthropic' : 'openai';
}

const DEFAULT_PROMPT =
  '这是一块协作画布的截图。请描述画面上有什么内容、它们的相对位置关系，' +
  '以及手绘笔触看起来在画什么。图元旁边的红色小字是它的 id，回答时请用这些 id 指代具体图形。' +
  '只描述你确实看到的，不要推测。';

export function makeVisionProvider(): VisionProvider {
  const { baseUrl, apiKey, model, protocol, maxTokens } = config.vlm;
  const proto = detectProtocol(baseUrl, protocol);
  const root = baseUrl.replace(/\/$/, '');

  log.info('vision.ready', { protocol: proto, model, base: root });

  return {
    async describe(png: Uint8Array, question?: string): Promise<string> {
      const b64 = Buffer.from(png).toString('base64');
      const prompt = question ?? DEFAULT_PROMPT;

      const { url, headers, body, pick } =
        proto === 'anthropic'
          ? {
              url: `${root}/v1/messages`,
              headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                authorization: `Bearer ${apiKey}`,
                'anthropic-version': '2023-06-01',
              },
              body: {
                model,
                max_tokens: maxTokens,
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
                      { type: 'text', text: prompt },
                    ],
                  },
                ],
              },
              pick: (j: unknown) =>
                ((j as { content?: Array<{ type: string; text?: string }> }).content ?? [])
                  .filter((c) => c.type === 'text')
                  .map((c) => c.text ?? '')
                  .join(''),
            }
          : {
              url: `${root}/chat/completions`,
              headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
              body: {
                model,
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: prompt },
                      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
                    ],
                  },
                ],
                max_tokens: maxTokens,
                temperature: 0.2,
              },
              pick: (j: unknown) =>
                (j as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? '',
            };

      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        log.error('vision.failed', { protocol: proto, status: res.status, detail: detail.slice(0, 300) });
        throw new Error(`视觉模型返回 ${res.status}: ${detail.slice(0, 200)}`);
      }

      const text = pick(await res.json()).trim();
      if (!text) {
        /**
         * 空内容要抛，不能伪装成一段描述返回。
         *
         * 早先返回 '(视觉模型没有返回内容)' 这个字符串，调用方分不清它是
         * 模型真的这么说还是接口抽风——在基准里就变成了"模型读不出这道题"，
         * 把偶发的基础设施抖动记成了模型能力缺陷。实测这在推理模型上
         * 每三十次会遇到一两次，finish_reason 还是正常的 stop。
         */
        throw new Error('视觉模型返回了空内容（偶发，可重试）');
      }
      return text;
    },
  };
}
