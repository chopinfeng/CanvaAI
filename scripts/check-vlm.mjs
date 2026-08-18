/**
 * 探测视觉模型是否可用。
 *
 *   node scripts/check-vlm.mjs                    # 用 .env 里的 VLM_* 或 ARK_*
 *   node scripts/check-vlm.mjs <model-id>         # 指定模型
 *
 * 会依次检查：能不能认证 → 模型开通了没 → 能不能读懂一张真实试卷扫描件。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 简易 .env 读取，不引依赖
const env = {};
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
}

const base = env.VLM_BASE_URL || env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
const key = env.VLM_API_KEY || env.ARK_API_KEY;
if (!key) {
  console.error('✗ .env 里没有 VLM_API_KEY 或 ARK_API_KEY');
  process.exit(1);
}

/** Agent Plan 走 Anthropic 协议、另一个 base；普通方舟走 OpenAI 协议 */
const isPlan = /\/api\/plan/.test(base);
const proto = isPlan ? 'anthropic' : 'openai';

const CANDIDATES = process.argv[2]
  ? [process.argv[2]]
  : isPlan
  ? ['ark-code-latest', 'ark-agent-latest']
  : [
      'doubao-seed-2-1-pro-260628',
      'doubao-seed-2-0-pro-260215',
      'doubao-seed-2-0-lite-260428',
      'doubao-seed-1-6-vision-250815',
      'doubao-1-5-vision-pro-32k-250115',
    ];

const post = async ({ model, text, image, maxTokens = 64 }) => {
  const content = image
    ? proto === 'anthropic'
      ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }, { type: 'text', text }]
      : [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }]
    : text;

  return proto === 'anthropic'
    ? fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          authorization: `Bearer ${key}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
      })
    : fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.1, messages: [{ role: 'user', content }] }),
      });
};

const pickText = (j) =>
  proto === 'anthropic'
    ? (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
    : j.choices?.[0]?.message?.content ?? '';

console.log(`端点 ${base}\n协议 ${proto}${isPlan ? '（Agent Plan 专属，需专属 API Key）' : ''}\n`);

/* ---- 1. 认证（仅 OpenAI 协议端点支持列目录） ---- */
if (!isPlan) {
  const list = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!list.ok) {
    console.error(`✗ 认证失败：HTTP ${list.status}。检查 API KEY。`);
    process.exit(1);
  }
  const catalog = (await list.json()).data?.map((m) => m.id) ?? [];
  console.log(`✓ 认证通过，目录里有 ${catalog.length} 个模型（目录 ≠ 已开通）\n`);
}

/* ---- 2. 逐个试 ---- */
let usable = null;
for (const model of CANDIDATES) {
  const r = await post({ model, text: 'hi', maxTokens: 4 });
  if (r.ok) {
    console.log(`✓ ${model} 可用`);
    usable = model;
    break;
  }
  const err = await r.json().catch(() => ({}));
  const code = err?.error?.code ?? `HTTP${r.status}`;
  const msg = err?.error?.message ?? '';
  const why =
    code === 'ModelNotOpen'
      ? '模型存在但未开通 → 方舟控制台「开通管理」里开通它'
      : r.status === 401
        ? 'API Key 无效。Agent Plan 需要专属 Key，普通方舟 Key 在这里用不了'
        : String(code).includes('NotFound')
          ? '该模型不存在或无权访问（可能已下线，或需要接入点 ep-xxx）'
          : msg.slice(0, 90);
  console.log(`✗ ${model.padEnd(34)} ${code} — ${why}`);
}

if (!usable) {
  console.log('\n没有可用的视觉模型。canvas_snapshot 会被自动摘掉，');
  console.log('画布上的标注位置仍然算得出来（canvas_describe 的 onImages），不影响主流程。');
  process.exit(2);
}

/* ---- 3. 真图实测 ---- */
const crop = join(root, '.work/crops/S3.png');
if (!existsSync(crop)) {
  console.log('\n（没找到 .work/crops/S3.png，跳过读图实测）');
  process.exit(0);
}
const r = await post({
  model: usable,
  text: '这是数学试卷扫描件。一句话说出：题号、讲的什么图形、配了几个小图。',
  image: readFileSync(crop).toString('base64'),
  maxTokens: 300,
});
if (!r.ok) {
  console.log(`\n✗ 该模型不支持图片输入：${(await r.text()).slice(0, 200)}`);
  process.exit(2);
}
const text = pickText(await r.json()).trim();
console.log(`\n✓ 读图成功：${text.replace(/\n/g, ' ').slice(0, 200)}`);
console.log(`\n把这三行填进 .env 后重启服务端即可：`);
console.log(`  VLM_BASE_URL=${base}`);
console.log(`  VLM_API_KEY=<你的 KEY>`);
console.log(`  VLM_MODEL=${usable}`);
if (isPlan) console.log(`  VLM_PROTOCOL=anthropic`);
