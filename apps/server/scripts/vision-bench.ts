/**
 * 视觉模型读题基准。
 *
 * 要回答的问题不是"视觉比现在准吗"——现在这条路读的是人工转录好的
 * 结构化文本，按构造就是 100% 准，比不了。真正有意义的问题是：
 *
 *   **视觉能不能替掉人工转录那一步？**
 *
 * 能替掉，用户就可以直接拍一张作业照片扔进来；替不掉，就还得有人先把题
 * 敲成文字。所以这里只给模型一张扫描件，让它把题目提取出来，
 * 拿 problems.ts 里的 ground truth 对分。
 *
 * 四个指标，最要紧的是最后一个：
 *   - 已知量保真：题给的每个数值有没有被正确读出来
 *   - 所求识别：知不知道这道题问的是什么
 *   - 考点识别：说不说得出考点（软指标，说法可以不同）
 *   - **数字幻觉**：提取里出现了 ground truth 里没有的数
 *
 * 幻觉那条是决定性的。辅导场景下模型读错一个数（把 AB=13 读成 12），
 * 后面整场推导全建在错的前提上，而它每一步都理直气壮——
 * 这比"读不出来"糟糕得多，因为读不出来至少会暴露。
 *
 * 用法：
 *   VLM_BASE_URL=https://api.moonshot.ai/v1 VLM_API_KEY=sk-xxx VLM_MODEL=kimi-k3 \
 *     npx tsx scripts/vision-bench.ts
 *   npx tsx scripts/vision-bench.ts --limit 5        # 先跑 5 道看看
 *   npx tsx scripts/vision-bench.ts --out bench.json # 存下来好和别的模型比
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, hasVision } from '../src/config.ts';
import { makeVisionProvider } from '../src/vision.ts';
import { PROBLEMS, type Problem } from './problems.ts';
import { parseJson, score, type Score } from '../src/bench-score.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CROPS = join(here, '../../../.work/crops');

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const limit = Number(flag('limit') ?? PROBLEMS.length);
const outFile = flag('out');

if (!hasVision()) {
  console.error(`没配视觉模型。三个变量都要给：

  VLM_BASE_URL=https://api.moonshot.ai/v1
  VLM_API_KEY=sk-xxx
  VLM_MODEL=kimi-k3

Kimi K3 是 OpenAI 兼容的，协议会自动识别，不用配 VLM_PROTOCOL。`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 提问
 * ------------------------------------------------------------------ */

/**
 * 只问"看到了什么"，不问"怎么解"。
 *
 * 让它顺手把题解了会污染这次测量：解题能力强的模型能靠常识把
 * 读漏的条件补回来，于是"读得准不准"就测不出来了。
 */
const PROMPT = `这是一张数学试卷的扫描件。请**只提取你在图上看到的内容**，不要解题，不要补充图上没有的条件。

按这个 JSON 格式回答，不要有别的文字：
{
  "statement": "完整题干原文",
  "known": { "量名": 数值 },
  "asks": ["第(1)问求什么", "第(2)问求什么"],
  "topic": "这道题的考点"
}

注意：
- known 只填题目**明确给出**的数值条件（如 AB=13），不要填你推算出来的。
- 看不清的地方写 "?"，不要猜。`;

/* ------------------------------------------------------------------ *
 * 跑
 * ------------------------------------------------------------------ */

/** problems.ts 的 Problem 里还带着画图函数，打分只要这几个字段 */
const toTruth = (p: Problem) => ({
  id: p.id,
  topic: p.topic,
  statement: p.statement,
  ...(p.known ? { known: p.known } : {}),
  ...(p.answer ? { answer: p.answer } : {}),
});

async function main(): Promise<void> {
  const vision = makeVisionProvider();
  const picked = PROBLEMS.slice(0, limit);

  console.log(`\n=== 读题基准 · ${config.vlm.model} · ${picked.length} 道题 ===`);
  console.log(`只给扫描件，不给转录文本。看它能不能替掉人工转录这一步。\n`);

  const scores: Score[] = [];
  let elapsed = 0;

  for (const p of picked) {
    process.stdout.write(`${p.id.padEnd(4)} ${p.topic.padEnd(22)} `);
    let png: Uint8Array;
    try {
      png = new Uint8Array(await readFile(join(CROPS, p.image)));
    } catch {
      console.log('扫描件缺失，跳过');
      continue;
    }

    const t0 = Date.now();
    let raw = '';
    try {
      raw = await vision.describe(png, PROMPT);
    } catch (e) {
      console.log(`调用失败：${(e as Error).message.slice(0, 60)}`);
      scores.push({
        id: p.id, ok: false, knownHit: 0, knownTotal: 0,
        asksHit: false, topicHit: false, hallucinated: [],
        note: (e as Error).message.slice(0, 80),
      });
      continue;
    }
    elapsed += Date.now() - t0;

    const s = score(toTruth(p), parseJson(raw), raw.length);
    scores.push(s);

    const mark = s.ok ? '✓' : '✗';
    const bits = [
      `已知 ${s.knownHit}/${s.knownTotal}`,
      s.asksHit ? '所求✓' : '所求✗',
      s.topicHit ? '考点✓' : '考点✗',
      s.hallucinated.length > 0 ? `编了 ${s.hallucinated.join(',')}` : '',
      s.note ?? '',
    ].filter(Boolean);
    console.log(`${mark}  ${bits.join(' · ')}`);
  }

  /* ---- 汇总 ---- */
  const n = scores.length || 1;
  const knownTotal = scores.reduce((a, s) => a + s.knownTotal, 0) || 1;
  const knownHit = scores.reduce((a, s) => a + s.knownHit, 0);
  const withHallu = scores.filter((s) => s.hallucinated.length > 0).length;

  console.log(`\n=== 汇总 ===`);
  console.log(`整题全对    ${scores.filter((s) => s.ok).length}/${n}`);
  console.log(`已知量保真  ${knownHit}/${knownTotal}  (${((knownHit / knownTotal) * 100).toFixed(0)}%)`);
  console.log(`所求识别    ${scores.filter((s) => s.asksHit).length}/${n}`);
  console.log(`考点识别    ${scores.filter((s) => s.topicHit).length}/${n}`);
  console.log(`**编数字**  ${withHallu}/${n} 道题出现了题目里没有的数`);
  console.log(`平均耗时    ${(elapsed / n / 1000).toFixed(1)}s/道`);

  console.log(`\n对照：现在的结构化路径在这几项上都是 100%——它读的是人工转录好的文本。`);
  console.log(`所以这份分数要回答的是"能不能省掉那次转录"，不是"谁更准"。`);
  if (withHallu > 0) {
    console.log(`\n⚠ 有 ${withHallu} 道题读出了不存在的数字。辅导场景下这比读不出来更糟——`);
    console.log(`  后面整场推导会建在错的前提上，而模型每一步都理直气壮。`);
  }

  if (outFile) {
    await writeFile(outFile, JSON.stringify({ model: config.vlm.model, scores }, null, 2));
    console.log(`\n明细写到 ${outFile}，可以和别的模型比。`);
  }
}

main().catch((e) => {
  console.error('跑挂了：', (e as Error).message);
  process.exit(1);
});
