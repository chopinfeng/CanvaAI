import {
  KgEdgeSchema,
  KgFileSchema,
  KgNodeSchema,
  type KgEdge,
  type KgEdgeType,
  type KgNode,
  type KgNodeLabel,
} from './schema.js';

/**
 * 知识图谱：一次读进内存，之后全是查。
 *
 * 为什么不上图数据库：整张图 1 万节点 / 2.3 万边，JSON 才几 MB，
 * 全塞内存里查询是微秒级的。为这个规模装一个 Neo4j，
 * 换来的是一个必须一直跑着的进程和一套要单独学的查询语言，不划算。
 * 真到了十倍规模再说——那时候这层接口不用动，换掉底下的实现就行。
 */

export interface Neighbor {
  node: KgNode;
  type: KgEdgeType;
  /** 边的方向：out 表示 this -> 它 */
  dir: 'out' | 'in';
  edge: KgEdge;
}

export class KnowledgeGraph {
  private readonly nodes = new Map<string, KgNode>();
  private readonly edges: KgEdge[] = [];
  private readonly out = new Map<string, KgEdge[]>();
  private readonly inc = new Map<string, KgEdge[]>();
  /** 名字 → id。同名的不同学科节点会有多个 */
  private readonly byName = new Map<string, string[]>();

  get size(): { nodes: number; edges: number } {
    return { nodes: this.nodes.size, edges: this.edges.length };
  }

  /**
   * 灌一册教材。
   *
   * 上游一册一个文件，所以这里做成可以反复调用的累加；
   * 重复 id 后来的覆盖前面的（同一册重灌时不会翻倍）。
   *
   * 逐条解析、坏的跳过：整册严格解析的话，285 条边里坏 1 条就一个节点都进不来。
   * 一对多的边（一道题考好几个知识点）在这里摊平成一条一条，
   * 上面所有查询就不用各自再处理这种形状。
   */
  load(raw: unknown): { nodes: number; edges: number; skipped: number } {
    const file = KgFileSchema.parse(raw);
    let skipped = 0;
    let nodeCount = 0;
    let edgeCount = 0;

    for (const item of file.nodes) {
      const parsed = KgNodeSchema.safeParse(item);
      if (!parsed.success) {
        skipped++;
        continue;
      }
      const n = parsed.data;
      this.nodes.set(n.id, n);
      nodeCount++;
      const key = n.name.trim();
      const ids = this.byName.get(key);
      if (!ids) this.byName.set(key, [n.id]);
      else if (!ids.includes(n.id)) ids.push(n.id);
    }

    for (const item of file.edges) {
      const parsed = KgEdgeSchema.safeParse(item);
      if (!parsed.success) {
        skipped++;
        continue;
      }
      const raw = parsed.data;

      // 一对多摊平：{source, target_name_to_ids:[a,b,c]} → 三条边
      const targets: Array<{ target: string; target_name?: string }> =
        raw.target !== undefined
          ? [{ target: raw.target, ...(raw.target_name ? { target_name: raw.target_name } : {}) }]
          : (raw.target_name_to_ids ?? []);

      if (targets.length === 0) {
        skipped++;
        continue;
      }

      for (const t of targets) {
        const e: KgEdge = {
          source: raw.source,
          target: t.target,
          type: raw.type,
          properties: raw.properties,
          ...(raw.source_name ? { source_name: raw.source_name } : {}),
          ...(raw.source_stem ? { source_stem: raw.source_stem } : {}),
          ...(t.target_name ? { target_name: t.target_name } : {}),
        };
        this.edges.push(e);
        push(this.out, e.source, e);
        push(this.inc, e.target, e);
        edgeCount++;
      }
    }

    return { nodes: nodeCount, edges: edgeCount, skipped };
  }

  get(id: string): KgNode | undefined {
    return this.nodes.get(id);
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  all(): KgNode[] {
    return [...this.nodes.values()];
  }

  byLabel(label: KgNodeLabel): KgNode[] {
    return this.all().filter((n) => n.label === label);
  }

  /**
   * 按名字找知识点。
   *
   * 先精确后包含：讲题时 Agent 手里往往只有"勾股定理"这四个字，
   * 精确命中就别再把"勾股定理的逆定理"混进来排在前面。
   */
  search(q: string, opts: { label?: KgNodeLabel; limit?: number } = {}): KgNode[] {
    const query = q.trim();
    if (!query) return [];
    const limit = opts.limit ?? 20;

    const exact = (this.byName.get(query) ?? []).map((id) => this.nodes.get(id)!).filter(Boolean);
    const loose = this.all().filter(
      (n) => n.name !== query && (n.name.includes(query) || aliasesOf(n).some((a) => a.includes(query))),
    );

    const hit = [...exact, ...loose];
    const filtered = opts.label ? hit.filter((n) => n.label === opts.label) : hit;
    return filtered.slice(0, limit);
  }

  neighbors(id: string, opts: { types?: KgEdgeType[]; dir?: 'out' | 'in' | 'both' } = {}): Neighbor[] {
    const dir = opts.dir ?? 'both';
    const want = opts.types ? new Set(opts.types) : null;
    const res: Neighbor[] = [];

    if (dir === 'out' || dir === 'both') {
      for (const e of this.out.get(id) ?? []) {
        if (want && !want.has(e.type)) continue;
        const node = this.nodes.get(e.target);
        if (node) res.push({ node, type: e.type, dir: 'out', edge: e });
      }
    }
    if (dir === 'in' || dir === 'both') {
      for (const e of this.inc.get(id) ?? []) {
        if (want && !want.has(e.type)) continue;
        const node = this.nodes.get(e.source);
        if (node) res.push({ node, type: e.type, dir: 'in', edge: e });
      }
    }
    return res;
  }

  /**
   * 学这个之前得先会哪些——顺着 `prerequisites_for` 往回走。
   *
   * 这是整张图对辅导最有用的一条边：学生卡在某一步时，
   * 真正的问题往往不在这一步，而在它依赖的上一个知识点。
   * 按层返回，第 0 层是直接前置——补课要从近的开始补，不是一口气丢给他整棵树。
   */
  prerequisites(id: string, depth = 2): Array<{ depth: number; node: KgNode; via: KgEdge }> {
    const seen = new Set<string>([id]);
    const out: Array<{ depth: number; node: KgNode; via: KgEdge }> = [];
    let frontier = [id];

    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        // A prerequisites_for B：A 是 B 的前置，所以从 B 往回找入边
        for (const e of this.inc.get(cur) ?? []) {
          if (e.type !== 'prerequisites_for' || seen.has(e.source)) continue;
          const node = this.nodes.get(e.source);
          if (!node) continue;
          seen.add(e.source);
          out.push({ depth: d, node, via: e });
          next.push(e.source);
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return out;
  }

  /** 会了这个之后能往下学什么 */
  unlocks(id: string, depth = 1): Array<{ depth: number; node: KgNode; via: KgEdge }> {
    const seen = new Set<string>([id]);
    const out: Array<{ depth: number; node: KgNode; via: KgEdge }> = [];
    let frontier = [id];

    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const e of this.out.get(cur) ?? []) {
          if (e.type !== 'prerequisites_for' || seen.has(e.target)) continue;
          const node = this.nodes.get(e.target);
          if (!node) continue;
          seen.add(e.target);
          out.push({ depth: d, node, via: e });
          next.push(e.target);
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    return out;
  }

  /**
   * 从一个节点铺开一小片子图，给可视化用。
   *
   * 整张图一次性画出来是一团毛线，谁也看不出什么。
   * 有用的永远是"以我正在学的这一点为中心的周围两跳"。
   */
  around(id: string, depth = 2, cap = 160): { nodes: KgNode[]; edges: KgEdge[] } {
    const root = this.nodes.get(id);
    if (!root) return { nodes: [], edges: [] };

    const keep = new Set<string>([id]);
    let frontier = [id];
    for (let d = 0; d < depth && keep.size < cap; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const e of [...(this.out.get(cur) ?? []), ...(this.inc.get(cur) ?? [])]) {
          for (const side of [e.source, e.target]) {
            if (keep.has(side) || !this.nodes.has(side)) continue;
            if (keep.size >= cap) break;
            keep.add(side);
            next.push(side);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }

    return {
      nodes: [...keep].map((k) => this.nodes.get(k)!),
      edges: this.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }

  /** 某道题考了哪些知识点 */
  conceptsOfExercise(id: string): KgNode[] {
    return this.neighbors(id, { types: ['tests_concept', 'tests_skill'], dir: 'out' }).map((n) => n.node);
  }

  stats(): {
    nodes: number;
    edges: number;
    byLabel: Record<string, number>;
    byEdgeType: Record<string, number>;
    subjects: string[];
  } {
    const byLabel: Record<string, number> = {};
    const subjects = new Set<string>();
    for (const n of this.nodes.values()) {
      byLabel[n.label] = (byLabel[n.label] ?? 0) + 1;
      const s = n.properties.subject;
      if (typeof s === 'string' && s) subjects.add(s);
    }
    const byEdgeType: Record<string, number> = {};
    for (const e of this.edges) byEdgeType[e.type] = (byEdgeType[e.type] ?? 0) + 1;

    return { nodes: this.nodes.size, edges: this.edges.length, byLabel, byEdgeType, subjects: [...subjects] };
  }
}

function push(m: Map<string, KgEdge[]>, k: string, e: KgEdge): void {
  const arr = m.get(k);
  if (arr) arr.push(e);
  else m.set(k, [e]);
}

function aliasesOf(n: KgNode): string[] {
  const a = n.properties.aliases;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
}
