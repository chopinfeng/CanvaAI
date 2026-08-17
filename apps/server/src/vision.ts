import type { VisionProvider } from '@canvai/agent';
import { config } from './config.ts';

/**
 * 视觉兜底。
 *
 * DeepSeek 是纯文本的，所以理解手绘笔触/位图时走一个独立的 VLM。
 * 接口是 OpenAI 兼容的 chat/completions + image_url，
 * Qwen-VL、GLM-4V、gpt-4o 之类都能直接接。
 */
export function makeVisionProvider(): VisionProvider {
  const { baseUrl, apiKey, model } = config.vlm;

  return {
    async describe(png: Uint8Array, question?: string): Promise<string> {
      const dataUri = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;

      const prompt =
        question ??
        '这是一块协作画布的截图。请描述画面上有什么内容、它们的相对位置关系，' +
          '以及手绘笔触看起来在画什么。图元旁边的红色小字是它的 id，回答时请用这些 id 指代具体图形。' +
          '只描述你确实看到的，不要推测。';

      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUri } },
              ],
            },
          ],
          max_tokens: 800,
          temperature: 0.2,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`视觉模型返回 ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content ?? '(视觉模型没有返回内容)';
    },
  };
}
