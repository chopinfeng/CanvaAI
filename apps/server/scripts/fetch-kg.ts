/**
 * 把 K12-KGraph 拉下来。
 *
 * 图谱本体来自 https://github.com/haolpku/K12-KGraph ——
 * 从人教版等官方教材抽出的 K1–K12 学科知识图谱，
 * 10685 节点 / 23278 边，覆盖数学、物理、化学、生物，
 * **每条边都带 evidence 回指教材原文**。选它就是为了这一条：
 * 讲题时说"这步依赖前面哪个知识点"，得说得出依据，不能是模型现编的。
 *
 * ⚠ 数据是 CC BY-NC-SA 4.0（署名-非商业-相同方式共享），代码是 MIT。
 * 所以**不把数据提交进本仓库**——那会把 NC 和 SA 传染给整个项目。
 * 用的时候现拉到 data/kg/（已 gitignore），本仓库只留这段脚本和出处。
 *
 * 用法：
 *   npx tsx scripts/fetch-kg.ts          # demo 分册（一册七上数学，几百 KB，够跑通）
 *   npx tsx scripts/fetch-kg.ts --full   # 完整四科（约 12MB，10685 节点 / 23278 边）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.ts';

const RAW = 'https://raw.githubusercontent.com/haolpku/K12-KGraph/main';

/** 仓库 demo/ 里直接可取的分册。完整版在 HF 上，见 --full */
const DEMO_FILES = ['demo/kg/math_7a_rjb.json'];

const HF_DATASET = 'lhpku20010120/K12-KGraph';
const HF_RAW = `https://huggingface.co/datasets/${HF_DATASET}/resolve/main/K12-KGraph`;

/** 完整版：按学科分册，四个文件。数学那册里才有勾股定理这类初中内容 */
const FULL_FILES = [
  'subject_specific_KG/math.json',
  'subject_specific_KG/physics.json',
  'subject_specific_KG/chemistry.json',
  'subject_specific_KG/biology.json',
];

async function main(): Promise<void> {
  const dir = join(config.dataDir, 'kg');

  const full = process.argv.includes('--full');
  const jobs = full
    ? FULL_FILES.map((f) => ({ path: f, url: `${HF_RAW}/${f}` }))
    : DEMO_FILES.map((f) => ({ path: f, url: `${RAW}/${f}` }));

  if (full) {
    console.log(`完整图谱：四科分册，约 12MB。来自 https://huggingface.co/datasets/${HF_DATASET}\n`);
  }

  await mkdir(dir, { recursive: true });
  let ok = 0;

  for (const job of jobs) {
    const { path, url } = job;
    process.stdout.write(`拉取 ${path} … `);
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`失败 ${res.status}`);
      continue;
    }
    const text = await res.text();
    // 先确认是能解析的 JSON 再落盘，别把一页 404 的 HTML 存成 .json
    let count = { nodes: 0, edges: 0 };
    try {
      const j = JSON.parse(text) as { nodes?: unknown[]; edges?: unknown[] };
      count = { nodes: j.nodes?.length ?? 0, edges: j.edges?.length ?? 0 };
    } catch {
      console.log('拿到的不是 JSON，跳过');
      continue;
    }
    await writeFile(join(dir, path.split('/').pop()!), text);
    console.log(`${count.nodes} 节点 / ${count.edges} 边`);
    ok++;
  }

  console.log(`\n落在 ${dir}/（${ok} 个文件）。`);
  console.log(
    full
      ? '注意授权：数据 CC BY-NC-SA 4.0（非商业 + 相同方式共享）。别把它打包进商用分发。'
      : '这只是一册七上数学；四科完整版用 npx tsx scripts/fetch-kg.ts --full',
  );
}

main().catch((e) => {
  console.error('拉取失败：', (e as Error).message);
  process.exit(1);
});
