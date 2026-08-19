import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KnowledgeGraph,
  emptyLearner,
  parseLearner,
  type LearnerState,
  type LearnerStore,
} from '@canvai/knowledge';

/**
 * MCP 进程自己读盘。
 *
 * 不走 HTTP 去问服务端，是因为 MCP 的使用场景就是"服务端没跑的时候也想查"——
 * Claude Desktop 里问一句"这孩子哪块薄弱"，不该要求先把画布服务起起来。
 * 两边读的是同一份文件，画布那边写完这边下次读就看得到。
 */

const here = dirname(fileURLToPath(import.meta.url));

/** 从仓库根往下找 data/，允许用 DATA_DIR 覆盖（和服务端同一个约定） */
export function dataDir(): string {
  const env = process.env.DATA_DIR;
  if (env) return resolve(env);
  return resolve(here, '../../../data');
}

export async function loadGraphFrom(): Promise<KnowledgeGraph> {
  const g = new KnowledgeGraph();
  const dir = join(dataDir(), 'kg');

  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    process.stderr.write(`没找到图谱数据（${dir}）。先跑 npx tsx apps/server/scripts/fetch-kg.ts\n`);
    return g;
  }

  for (const f of files) {
    try {
      g.load(JSON.parse(await readFile(join(dir, f), 'utf8')) as unknown);
    } catch (e) {
      process.stderr.write(`${f} 读不进来：${(e as Error).message}\n`);
    }
  }
  return g;
}

/** 和服务端 FileLearnerStore 同构：一个学生一个 JSON，写临时文件再 rename */
class FileStore implements LearnerStore {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    return join(this.dir, `${id.replace(/[^\w.-]/g, '_')}.json`);
  }

  async get(learnerId: string): Promise<LearnerState> {
    try {
      return parseLearner(JSON.parse(await readFile(this.path(learnerId), 'utf8')) as unknown, learnerId);
    } catch {
      return emptyLearner(learnerId);
    }
  }

  async save(state: LearnerState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const p = this.path(state.learnerId);
    await writeFile(`${p}.tmp`, JSON.stringify(state));
    await rename(`${p}.tmp`, p);
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }
}

export function storeFrom(): LearnerStore {
  return new FileStore(join(dataDir(), 'learners'));
}
