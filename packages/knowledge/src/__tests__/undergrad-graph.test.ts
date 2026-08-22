import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KnowledgeGraph } from '../graph.js';

/**
 * 本科数学那份图谱是本项目自建的（MIT，随代码入库），所以它的质量由我们自己负责。
 *
 * 自建数据最容易出的三种错，装图时**都不报错**：
 *   - 前置边指向一个不存在的知识点 → 安静地少一条边
 *   - 两个知识点重名 → mentions 认出来的是哪一个全看顺序
 *   - 前置关系成环 → 「卡住了往回退一步」会无限绕
 * 所以这里逐条挡住。
 */

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/undergrad-math.json',
);

interface Raw {
  nodes: Array<{ id: string; label: string; name: string; properties: Record<string, unknown> }>;
  edges: Array<{ source: string; target?: string; type: string }>;
}

const load = async (): Promise<Raw> => JSON.parse(await readFile(FILE, 'utf8')) as Raw;

describe('本科数学图谱', () => {
  it('三门课都在，知识点数量对得上规模', async () => {
    const raw = await load();
    const concepts = raw.nodes.filter((n) => n.label === 'Concept');
    expect(concepts.length).toBeGreaterThan(120);

    const subjects = new Set(concepts.map((n) => n.properties.subject));
    expect(subjects).toEqual(new Set(['高等数学', '线性代数', '概率论与数理统计']));
  });

  it('每个知识点都有定义——没定义的点在辅导里等于一个空壳', async () => {
    const raw = await load();
    for (const n of raw.nodes.filter((x) => x.label === 'Concept')) {
      expect(typeof n.properties.definition, n.name).toBe('string');
      expect((n.properties.definition as string).length, n.name).toBeGreaterThan(4);
    }
  });

  it('知识点不重名——重名的话 mentions 认出哪一个全看顺序', async () => {
    const raw = await load();
    const names = raw.nodes.filter((n) => n.label === 'Concept').map((n) => n.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dup).toEqual([]);
  });

  it('没有悬空边——边指向不存在的节点时，装图不报错，只是安静地少一条', async () => {
    const raw = await load();
    const ids = new Set(raw.nodes.map((n) => n.id));
    const dangling = raw.edges.filter((e) => !ids.has(e.source) || (e.target && !ids.has(e.target)));
    expect(dangling).toEqual([]);
  });

  it('前置关系无环——成环的话「往回退一步补基础」会无限绕', async () => {
    const raw = await load();
    const next = new Map<string, string[]>();
    for (const e of raw.edges) {
      if (e.type !== 'prerequisites_for' || !e.target) continue;
      next.set(e.source, [...(next.get(e.source) ?? []), e.target]);
    }

    const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 / 1 在栈上 / 2 已完成
    const cycle: string[] = [];
    const walk = (id: string, path: string[]): boolean => {
      if (state.get(id) === 1) {
        cycle.push(...path.slice(path.indexOf(id)), id);
        return true;
      }
      if (state.get(id) === 2) return false;
      state.set(id, 1);
      for (const to of next.get(id) ?? []) {
        if (walk(to, [...path, id])) return true;
      }
      state.set(id, 2);
      return false;
    };

    for (const id of next.keys()) {
      if (walk(id, [])) break;
    }
    expect(cycle).toEqual([]);
  });

  it('装进 KnowledgeGraph 之后一条都不丢', async () => {
    const raw = await load();
    const g = new KnowledgeGraph();
    const n = g.load(raw);
    expect(n.skipped).toBe(0);
    expect(n.nodes).toBe(raw.nodes.length);
  });

  it('从整句话里认得出本科知识点——这是它加进来的全部理由', async () => {
    const g = new KnowledgeGraph();
    g.load(await load());

    const cases: Array<[string, string]> = [
      ['在约束条件 x+2y=5 下求 x²+y² 的最小值，用拉格朗日乘数法', '条件极值与拉格朗日乘数法'],
      ['右端与齐次解重合，特解要用待定系数法升一次幂', '待定系数法'],
      ['先求收敛半径与收敛域，再求和函数', '收敛半径与收敛域'],
      // 用 U13 题面里的原话，不是我编一句刚好能中的
      ['换成极坐标，写出积分限和被积表达式（注意面积元）', '二重积分极坐标换元'],
      ['实对称矩阵的对角化必可用正交矩阵完成', '实对称矩阵的对角化'],
      ['由全概率公式求次品率，再用贝叶斯公式反推', '贝叶斯公式'],
    ];

    for (const [text, want] of cases) {
      const got = g.mentions(text, { limit: 4 }).map((x) => x.name);
      expect(got, text).toContain(want);
    }
  });

  it('每个知识点都挂在某一章下面，没有孤儿', async () => {
    const raw = await load();
    const inChapter = new Set(
      raw.edges.filter((e) => e.type === 'is_part_of').map((e) => e.source),
    );
    for (const n of raw.nodes.filter((x) => x.label === 'Concept')) {
      expect(inChapter.has(n.id), n.name).toBe(true);
    }
  });
});
