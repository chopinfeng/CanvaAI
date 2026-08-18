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

const CANDIDATES = process.argv[2]
  ? [process.argv[2]]
  : [
      'doubao-seed-2-1-pro-260628',
      'doubao-seed-2-0-pro-260215',
      'doubao-seed-2-0-lite-260428',
      'doubao-seed-1-6-vision-250815',
      'doubao-1-5-vision-pro-32k-250115',
    ];

const post = async (body) =>
  fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

/* ---- 1. 认证 ---- */
const list = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
if (!list.ok) {
  console.error(`✗ 认证失败：HTTP ${list.status}。检查 API KEY。`);
  process.exit(1);
}
const catalog = (await list.json()).data?.map((m) => m.id) ?? [];
console.log(`✓ 认证通过，目录里有 ${catalog.length} 个模型（目录 ≠ 已开通）\n`);

/* ---- 2. 逐个试 ---- */
let usable = null;
for (const model of CANDIDATES) {
  const r = await post({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
  if (r.ok) {
    console.log(`✓ ${model} 可用`);
    usable = model;
    break;
  }
  const err = await r.json().catch(() => ({}));
  const code = err?.error?.code ?? `HTTP${r.status}`;
  const why =
    code === 'ModelNotOpen'
      ? '模型存在但未开通 → 方舟控制台「开通管理」里开通它'
      : code.includes('NotFound')
        ? '该模型不存在或无权访问（可能已下线，或需要用接入点 ep-xxx）'
        : err?.error?.message?.slice(0, 90) ?? '';
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
const uri = `data:image/png;base64,${readFileSync(crop).toString('base64')}`;
const r = await post({
  model: usable,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这是数学试卷扫描件。一句话说出：题号、讲的什么图形、配了几个小图。' },
        { type: 'image_url', image_url: { url: uri } },
      ],
    },
  ],
  max_tokens: 300,
  temperature: 0.1,
});
if (!r.ok) {
  console.log(`\n✗ 该模型不支持图片输入：${(await r.text()).slice(0, 200)}`);
  process.exit(2);
}
const text = (await r.json()).choices?.[0]?.message?.content?.trim() ?? '';
console.log(`\n✓ 读图成功：${text.replace(/\n/g, ' ').slice(0, 200)}`);
console.log(`\n把这三行填进 .env 后重启服务端即可：`);
console.log(`  VLM_BASE_URL=${base}`);
console.log(`  VLM_API_KEY=<你的 KEY>`);
console.log(`  VLM_MODEL=${usable}`);
