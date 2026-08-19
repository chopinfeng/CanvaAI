#!/usr/bin/env -S npx tsx
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { bandOf, recommend, snapshot } from '@canvai/knowledge';
import { loadGraphFrom, storeFrom } from './load.js';

/**
 * 知识图谱的 MCP 服务。
 *
 * 为什么除了 HTTP 还要有这个：HTTP 那套是给我们自己的前端用的；
 * MCP 是给**别的 Agent** 用的——Claude Desktop、Cursor、或者任何
 * 接了 MCP 的工具，都能直接问"这孩子哪块薄弱""学这个之前要先会什么"，
 * 不用先知道我们的接口长什么样。图谱这种东西的价值本来就在被到处引用。
 *
 * 走 stdio：一个学生的学习记录不该挂在一个公网端口上。
 *
 * 用法（Claude Desktop 的 config）：
 *   "canvai-kg": { "command": "npx", "args": ["tsx", "<repo>/apps/mcp/src/index.ts"] }
 */

const graph = await loadGraphFrom();
const store = storeFrom();

const server = new McpServer({ name: 'canvai-kg', version: '0.1.0' });

/* ------------------------------------------------------------------ *
 * 查图
 * ------------------------------------------------------------------ */

server.registerTool(
  'kg_search',
  {
    title: '找知识点',
    description:
      '在 K12 学科知识图谱里按名字找知识点，返回 id、定义、所属教材。' +
      '拿到 id 之后才能用其他工具查前置、看掌握度。',
    inputSchema: {
      query: z.string().describe('知识点名字，用课本上的叫法，如「勾股定理」「有理数」'),
      limit: z.number().int().min(1).max(20).default(5),
    },
  },
  async ({ query, limit }) => {
    const hits = graph.search(query, { limit });
    return text(
      hits.length === 0
        ? `图谱里没有「${query}」。换个课本上的叫法再试。`
        : hits
            .map(
              (n) =>
                `${n.id}  ${n.name}（${n.label}）` +
                (typeof n.properties.definition === 'string' ? `\n    ${n.properties.definition}` : ''),
            )
            .join('\n'),
    );
  },
);

server.registerTool(
  'kg_prerequisites',
  {
    title: '学这个之前要先会什么',
    description:
      '顺着教材里的前置关系往回找。学生卡在某一步时，问题往往不在这一步，' +
      '而在它依赖的上一个知识点——这个工具就是用来找那个点的。' +
      '每条关系都带教材原文作为依据。',
    inputSchema: {
      id: z.string().describe('知识点 id，用 kg_search 拿'),
      depth: z.number().int().min(1).max(4).default(2),
    },
  },
  async ({ id, depth }) => {
    if (!graph.has(id)) return text(`没有这个知识点：${id}`);
    const pre = graph.prerequisites(id, depth);
    if (pre.length === 0) return text(`${graph.get(id)!.name} 没有登记前置知识——它大概就是这一章的起点。`);
    return text(
      pre
        .map((p) => {
          const ev = p.via.properties.evidence;
          return (
            `${'  '.repeat(p.depth)}← ${p.node.name}（${p.node.id}）` +
            (typeof ev === 'string' && ev ? `\n${'  '.repeat(p.depth)}   依据：${ev}` : '')
          );
        })
        .join('\n'),
    );
  },
);

server.registerTool(
  'kg_node',
  {
    title: '看一个知识点的全貌',
    description: '定义、例子、前置、后继、以及哪些题考它。',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const n = graph.get(id);
    if (!n) return text(`没有这个知识点：${id}`);
    const pre = graph.prerequisites(id, 1).map((p) => p.node.name);
    const next = graph.unlocks(id, 1).map((p) => p.node.name);
    const testedBy = graph
      .neighbors(id, { types: ['tests_concept', 'tests_skill'], dir: 'in' })
      .map((x) => x.node);

    return text(
      [
        `${n.name}（${n.label} · ${n.id}）`,
        typeof n.properties.definition === 'string' ? `定义：${n.properties.definition}` : '',
        Array.isArray(n.properties.examples) ? `例子：${(n.properties.examples as unknown[]).join('、')}` : '',
        pre.length ? `先修：${pre.join('、')}` : '',
        next.length ? `之后可学：${next.join('、')}` : '',
        testedBy.length
          ? `考它的题：${testedBy
              .slice(0, 5)
              .map((e) => (typeof e.properties.stem === 'string' ? e.properties.stem.slice(0, 40) : e.name))
              .join(' / ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  },
);

/* ------------------------------------------------------------------ *
 * 学生
 * ------------------------------------------------------------------ */

server.registerTool(
  'kg_mastery',
  {
    title: '这个学生哪些会哪些不会',
    description:
      '返回他练过的每个知识点的掌握度（0~1）和分档：mastered 基本掌握 / learning 学着呢 / shaky 薄弱。' +
      '注意掌握度带时间衰减——很久没碰的会往"说不好"退，所以这里给的是**今天**的估计。',
    inputSchema: { learnerId: z.string().describe('学生 id；本项目里就是房间名') },
  },
  async ({ learnerId }) => {
    const state = await store.get(learnerId);
    const snap = snapshot(state);
    const rows = Object.entries(snap)
      .map(([id, v]) => ({ id, name: graph.get(id)?.name ?? id, ...v, m: state.mastery[id]! }))
      .sort((a, b) => a.level - b.level);

    if (rows.length === 0) return text(`${learnerId} 还没有学习记录。`);
    return text(
      rows
        .map(
          (r) =>
            `${r.band === 'mastered' ? '✓' : r.band === 'shaky' ? '✗' : '·'} ${r.name}  ` +
            `${r.level.toFixed(2)}  （做过 ${r.m.attempts} 次，对 ${r.m.correct} 次）`,
        )
        .join('\n'),
    );
  },
);

server.registerTool(
  'kg_next',
  {
    title: '这个学生接下来该学什么',
    description:
      '按"先补洞、再往前走"给建议：自己薄弱的排最前，其次是前置有洞的，' +
      '最后才是已掌握之后可以解锁的新知识点。',
    inputSchema: { learnerId: z.string(), limit: z.number().int().min(1).max(20).default(6) },
  },
  async ({ learnerId, limit }) => {
    const state = await store.get(learnerId);
    const rec = recommend(graph, state, { limit });
    if (rec.length === 0) return text(`${learnerId} 还没有足够的学习记录，先做几道题。`);
    return text(rec.map((r) => `${r.node!.name}（${r.node!.id}）—— ${r.reason}`).join('\n'));
  },
);

server.registerTool(
  'kg_record',
  {
    title: '记一次练习结果',
    description:
      '学生做完题之后把结果记进图谱。guided=true 表示他是被一路引导着做出来的——' +
      '这种只算"跟得上"，涨分有天花板，跨不过"已掌握"那条线；' +
      '独立做对才算数。这个区分是这套掌握度有没有意义的关键。',
    inputSchema: {
      learnerId: z.string(),
      attempts: z
        .array(
          z.object({
            conceptId: z.string(),
            ok: z.boolean(),
            guided: z.boolean().default(false),
          }),
        )
        .min(1),
    },
  },
  async ({ learnerId, attempts }) => {
    const known = attempts.filter((a) => graph.has(a.conceptId));
    const unknown = attempts.filter((a) => !graph.has(a.conceptId));
    if (known.length === 0) return text('这些 conceptId 图谱里都没有，没记。先用 kg_search 拿到真实 id。');

    const state = await store.get(learnerId);
    const { record } = await import('@canvai/knowledge');
    const now = Date.now();
    const out = known.map((a) => record(state, { ...a, at: now }));
    await store.save(state);

    return text(
      out
        .map(
          (m) =>
            `${graph.get(m.conceptId)?.name ?? m.conceptId} → ${m.level.toFixed(2)}（${bandOf(m.level)}）`,
        )
        .join('\n') + (unknown.length > 0 ? `\n\n跳过了图谱里没有的：${unknown.map((u) => u.conceptId).join('、')}` : ''),
    );
  },
);

/* ------------------------------------------------------------------ */

function text(s: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: s }] };
}

const stats = graph.stats();
// 走 stderr：stdout 是 MCP 的协议通道，往里写一个字都会把握手搞坏
process.stderr.write(`canvai-kg MCP 就绪：${stats.nodes} 个知识点 / ${stats.edges} 条关系\n`);

await server.connect(new StdioServerTransport());
