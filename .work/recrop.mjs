/**
 * 按 crops.json 重新裁剪每道题的原图。
 * 直接从 PDF 裁（pdftoppm 的 -x/-y/-W/-H），不经过整页 PNG，避免二次损失。
 *
 *   node .work/recrop.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const crops = JSON.parse(readFileSync(join(here, 'crops.json'), 'utf8'));
const outDir = join(here, 'crops');
mkdirSync(outDir, { recursive: true });

for (const c of crops) {
  execFileSync('pdftoppm', [
    '-png', '-r', '130',
    '-f', String(c.page), '-l', String(c.page),
    '-x', '95', '-y', String(c.y), '-W', '890', '-H', String(c.h),
    join(here, 'pdf', `${c.pdf}.pdf`),
    join(outDir, c.id),
  ]);
  // pdftoppm 会追加页码后缀，统一改回纯 id
  for (const f of readdirSync(outDir)) {
    if (f.startsWith(`${c.id}-`) && f.endsWith('.png')) {
      renameSync(join(outDir, f), join(outDir, `${c.id}.png`));
    }
  }
  console.log(`${c.id}  p${c.page} y=${c.y} h=${c.h}  ${c.src}`);
}
console.log(`\n共裁出 ${crops.length} 张 → ${outDir}`);
