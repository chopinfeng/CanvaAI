import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgePort } from '@canvai/agent';
import {
  KnowledgeGraph,
  MemoryLearnerStore,
  recordAttempts,
  type LearnerState,
  type LearnerStore,
  emptyLearner,
  parseLearner,
} from '@canvai/knowledge';
import { config } from './config.ts';
import { log } from './log.ts';
import { blobs } from './blobs.ts';

/**
 * 知识图谱与学习记录的服务端装配。
 *
 * 图谱是只读的、全进程共享一份（1 万节点几 MB，没必要每个房间一份）；
 * 学习记录是每个学生一份、要落盘的——画布丢了可以重画，
 * "我哪些会哪些不会"攒了几个月，丢了就真没了。
 */

let graph: KnowledgeGraph | null = null;

/** 图谱在磁盘上的位置。data/kg/*.json，一册教材一个文件 */
export const kgDir = (): string => join(config.dataDir, 'kg');

/**
 * 读盘装图。
 *
 * 没有数据目录不是错误：没跑过 fetch-kg 的人也该能正常用画布，
 * 只是知识图谱那部分功能不出现。所以这里安静地返回空图，
 * 由 /kg/stats 告诉调用方「还没装数据，去跑 fetch-kg」。
 */
export async function loadGraph(): Promise<KnowledgeGraph> {
  if (graph) return graph;
  const g = new KnowledgeGraph();
  const dir = kgDir();

  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    log.warn('kg.absent', { dir, hint: '跑 npx tsx scripts/fetch-kg.ts 把图谱拉下来' });
    graph = g;
    return g;
  }

  for (const f of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, f), 'utf8')) as unknown;
      const n = g.load(raw);
      log.info('kg.loaded', { file: f, ...n });
    } catch (e) {
      // 一册坏了不该让其他册也进不来
      log.error('kg.load_failed', { file: f, message: (e as Error).message });
    }
  }

  const s = g.stats();
  log.info('kg.ready', { nodes: s.nodes, edges: s.edges, files: files.length });
  graph = g;
  return g;
}

/** 测试用：换一张图进来 */
export function setGraph(g: KnowledgeGraph | null): void {
  graph = g;
}

/**
 * 重新读盘装图。
 *
 * 图是进程内缓存的（1 万节点，每次请求重读不划算），代价是拉了新教材之后
 * 服务端还在发旧的那张——我自己就先栽在这儿：跑完 fetch-kg --full，
 * /kg/stats 还是 157 个节点，愣是没反应过来是缓存。所以给它一个明确的出口。
 */
export async function reloadGraph(): Promise<KnowledgeGraph> {
  graph = null;
  return loadGraph();
}

/* ------------------------------------------------------------------ *
 * 学习记录：落盘
 * ------------------------------------------------------------------ */

/**
 * 一个学生一个 JSON 文件。
 *
 * 和房间快照一样走「写临时文件再 rename」：写到一半断电时，
 * 磁盘上要么是旧的完整文件，要么是新的完整文件，不会是半截。
 */
export class BlobLearnerStore implements LearnerStore {
  private key(id: string): string {
    return `learners/${id.replace(/[^\w.-]/g, '_')}.json`;
  }

  async get(learnerId: string): Promise<LearnerState> {
    try {
      const raw = await blobs().get(this.key(learnerId));
      if (!raw) return emptyLearner(learnerId);
      return parseLearner(JSON.parse(new TextDecoder().decode(raw)) as unknown, learnerId);
    } catch (e) {
      // 读不出来就当新学生，但要吼一声：静默丢掌握度是这套东西最不该出的事
      log.error('kg.learner_read_failed', { learner: learnerId, message: (e as Error).message });
      return emptyLearner(learnerId);
    }
  }

  async save(state: LearnerState): Promise<void> {
    await blobs().put(this.key(state.learnerId), new TextEncoder().encode(JSON.stringify(state)));
  }

  async list(): Promise<string[]> {
    const keys = await blobs().list('learners');
    return keys.filter((k) => k.endsWith('.json')).map((k) => k.split('/').pop()!.slice(0, -5));
  }
}

let store: LearnerStore | null = null;

export function learnerStore(): LearnerStore {
  if (!store) store = new BlobLearnerStore();
  return store;
}

/** 测试用 */
export function setLearnerStore(s: LearnerStore | null): void {
  store = s ?? new MemoryLearnerStore();
}

/* ------------------------------------------------------------------ *
 * 给 Agent 用的出口
 * ------------------------------------------------------------------ */

/**
 * 把图谱和学习记录包成 Agent 认识的形状。
 *
 * learnerId 用房间 id：这个项目里"一个房间"就等于"一个人在学"，
 * 没有账号体系。真接了登录之后，把这里换成用户 id 就行，别的都不用动。
 *
 * search 是同步的（图在内存里，微秒级），record 是异步的（要落盘）。
 * 这个不对称是故意留在接口上的——查图随便查，写盘是有代价的。
 */
export function makeKnowledgePort(learnerId: string): KnowledgePort {
  return {
    search(query, limit = 5) {
      const g = graph;
      if (!g) return []; // 还没装完就当没有，别把辅导卡住
      return g.search(query, { limit }).map((n) => ({
        id: n.id,
        name: n.name,
        label: n.label,
        ...(typeof n.properties.definition === 'string'
          ? { definition: n.properties.definition }
          : {}),
      }));
    },

    prerequisites(id) {
      const g = graph;
      if (!g) return [];
      return g.prerequisites(id, 1).map((p) => ({ id: p.node.id, name: p.node.name }));
    },

    async record(attempts) {
      const g = await loadGraph();
      // 图里没有的不记：宁可少记，也不要在图谱上长出一堆幽灵节点
      const known = attempts.filter((a) => g.has(a.conceptId));
      if (known.length === 0) return;
      const now = Date.now();
      await recordAttempts(
        learnerStore(),
        learnerId,
        known.map((a) => ({ ...a, at: now })),
      );
      log.info('kg.learned', { learner: learnerId, concepts: known.length });
    },
  };
}
