/**
 * 把每道自编题渲染成一张"试卷扫描件"。
 *
 * 为什么需要：画布的核心演示是「左边原图、右边转换结果」并排对照。
 * 题库换成自编内容后，就没有真实扫描件可用了——于是自己造一张：
 * 用衬线字体、纸色背景、轻微倾斜，模拟纸质试卷的观感。
 *
 * 要说清楚的是：**这种自造原图与转换结果同源**，所以左右对照此时只是
 * 流水线的冒烟测试，不构成对转录准确性的独立校验。真正要校验转录，
 * 得换成真实扫描件（流程见 docs/PROBLEM-SETS.md）。
 *
 *   npx tsx scripts/make-mock-scans.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scene, sceneToSvg } from '@canvai/canvas-core';
import type { ShapeInput } from '@canvai/protocol';
import { initRasterizer } from '../src/rasterizer.ts';
import { PROBLEMS } from './problems.ts';

/**
 * 衬线字体里没有的字形。
 *
 * 踩过一次：H3 用了 `{aₙ}`，U+2099（下标 n）不在 Songti/SimSun 里，
 * 渲染出来整行都是 `?` 豆腐块。基准跑到那道题，模型如实读出 `?`——
 * 完全正确——却被记成"模型读不出题"。一张静默损坏的图，
 * 会让整个测量指向错误的结论。
 *
 * 下标字母（U+2090–U+209C）是重灾区：下标**数字** ₀₁₂ 大多有，
 * 下标**字母** ₙ ₐ ₓ 基本都没有。
 */
const MISSING_GLYPHS = /[\u2090-\u209c]/;

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../../../.work/crops');

const PAPER = '#fbfaf7';
const INK = '#1a1a1a';
const SERIF = '"Songti SC", "SimSun", "Source Han Serif SC", serif';
const W = 890;

/** 按字宽估算折行；扫描件版面窄一些，看起来才像印刷品 */
function wrap(text: string, maxPx: number, fontSize: number): string[] {
  const perLine = maxPx / fontSize;
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let cur = '';
    let units = 0;
    for (const ch of para) {
      const w = ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55;
      if (units + w > perLine) {
        out.push(cur);
        cur = '';
        units = 0;
      }
      cur += ch;
      units += w;
    }
    out.push(cur);
  }
  return out;
}

const raster = await initRasterizer();
if (!raster) {
  console.error('没有可用的光栅化器（需要 @resvg/resvg-js）');
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

/** 先整体体检：有一处渲染不出来就别生成，免得基准跑在坏图上 */
const broken = PROBLEMS.filter((p) => MISSING_GLYPHS.test(p.statement));
if (broken.length > 0) {
  console.error('这些题里有衬线字体渲染不出来的字形，会变成 ? 豆腐块：\n');
  for (const p of broken) {
    const bad = [...new Set([...p.statement].filter((c) => MISSING_GLYPHS.test(c)))];
    console.error(`  ${p.id}  用到了 ${bad.map((c) => `${c} (U+${c.codePointAt(0)!.toString(16).toUpperCase()})`).join('、')}`);
  }
  console.error('\n换个写法（比如 {aₙ} → {a_n}）再生成。');
  process.exit(1);
}

for (const [i, p] of PROBLEMS.entries()) {
  const scene = new Scene();
  const shapes: ShapeInput[] = [];

  const FS = 17;
  const lines = wrap(p.statement, W - 120, FS);

  shapes.push({
    type: 'text',
    x: 40,
    y: 34,
    text: `${i + 1}．（${p.topic}）`,
    style: { stroke: INK, fontSize: FS + 1, fontFamily: SERIF },
    meta: { role: 'scan-heading' },
  });

  lines.forEach((ln, k) => {
    shapes.push({
      type: 'text',
      x: 58,
      y: 72 + k * (FS * 1.75),
      text: ln,
      style: { stroke: INK, fontSize: FS, fontFamily: SERIF },
      meta: { role: 'scan-line' },
    });
  });

  let bottom = 72 + lines.length * (FS * 1.75) + 20;

  if (p.figure) {
    const origin = { x: 300, y: bottom + 210 };
    shapes.push(...p.figure(origin));
    bottom += 250;
  }

  scene.create(shapes, { author: { id: 'mock', kind: 'user', name: '试卷' } });

  const H = Math.max(200, Math.round(bottom + 30));
  const svg = sceneToSvg(scene.all(), {
    region: [0, 0, W, H],
    scale: 1,
    background: PAPER,
  });

  const png = await raster.render(svg, 1);
  await writeFile(join(OUT, p.image), png);
  console.log(`  ${String(i + 1).padStart(2)}. ${p.image.padEnd(9)} ${W}×${H}  ${Math.round(png.length / 1024)}KB  ${p.topic}`);
}

console.log(`\n已生成 ${PROBLEMS.length} 张模拟扫描件 → ${OUT}`);
