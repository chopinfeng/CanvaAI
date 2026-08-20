import type { IncomingMessage, ServerResponse } from 'node:http';
import { AttemptSchema, bandOf, recommend, recordAttempts, snapshot } from '@canvai/knowledge';
import type { KgNodeLabel } from '@canvai/knowledge';
import { learnerStore, loadGraph, reloadGraph } from './knowledge.ts';
import { log } from './log.ts';

/**
 * 知识图谱的 HTTP 接口。
 *
 * 三类调用方，接口形状是照着它们的需要定的，不是照着图的内部结构：
 * - 可视化页面要「一小片子图 + 每个点的掌握度」，一次拿全（/kg/around）
 * - Agent / MCP 要「这个知识点的前置是什么」（/kg/prereq）
 * - 辅导结束时要写一批练习结果（POST /kg/attempts）
 *
 * 一律 JSON，一律不缓存——掌握度是会变的，缓存住只会让人看到旧的绿。
 */

export async function handleKg(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/kg')) return false;

  try {
    const handled = await route(req, res, url);
    if (!handled) json(res, 404, { error: `没有这个接口：${url.pathname}` });
  } catch (e) {
    log.error('kg.api_failed', { path: url.pathname, message: (e as Error).message });
    json(res, 500, { error: (e as Error).message });
  }
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const graph = await loadGraph();
  const p = url.pathname;
  const seg = (prefix: string): string | null =>
    p.startsWith(prefix) ? decodeURIComponent(p.slice(prefix.length)) : null;

  /* ---- 概况。没装数据时也要能答，并说清怎么装 ---- */
  if (p === '/kg/stats') {
    const s = graph.stats();
    json(res, 200, {
      ...s,
      ready: s.nodes > 0,
      ...(s.nodes === 0
        ? { hint: '还没装图谱数据。跑 npx tsx apps/server/scripts/fetch-kg.ts' }
        : {}),
      source: {
        name: 'K12-KGraph',
        repo: 'https://github.com/haolpku/K12-KGraph',
        license: { data: 'CC BY-NC-SA 4.0', code: 'MIT' },
      },
    });
    return true;
  }

  /* ---- 拉了新教材之后让它重读一遍，不用重启服务 ---- */
  if (p === '/kg/reload' && req.method === 'POST') {
    const g = await reloadGraph();
    const s = g.stats();
    log.info('kg.reloaded', { nodes: s.nodes, edges: s.edges });
    json(res, 200, { reloaded: true, nodes: s.nodes, edges: s.edges, subjects: s.subjects });
    return true;
  }

  if (p === '/kg/search') {
    const q = url.searchParams.get('q') ?? '';
    const label = (url.searchParams.get('label') ?? undefined) as KgNodeLabel | undefined;
    const limit = Number(url.searchParams.get('limit') ?? 20);
    json(res, 200, { query: q, hits: graph.search(q, { ...(label ? { label } : {}), limit }) });
    return true;
  }

  /* ---- 单点详情：节点 + 邻居 + 前置 + 后继，一次给够 ---- */
  const nodeId = seg('/kg/node/');
  if (nodeId) {
    const node = graph.get(nodeId);
    if (!node) {
      json(res, 404, { error: `没有这个节点：${nodeId}` });
      return true;
    }
    json(res, 200, {
      node,
      neighbors: graph.neighbors(nodeId).map((n) => ({ ...n, edge: undefined })),
      prerequisites: graph.prerequisites(nodeId, 2),
      unlocks: graph.unlocks(nodeId, 1),
    });
    return true;
  }

  const prereqId = seg('/kg/prereq/');
  if (prereqId) {
    const depth = Number(url.searchParams.get('depth') ?? 2);
    json(res, 200, { id: prereqId, prerequisites: graph.prerequisites(prereqId, depth) });
    return true;
  }

  /* ---- 可视化要的那一片：子图 + 掌握度，一次拿全 ---- */
  const aroundId = seg('/kg/around/');
  if (aroundId) {
    const depth = Number(url.searchParams.get('depth') ?? 2);
    const cap = Number(url.searchParams.get('cap') ?? 160);
    const learner = url.searchParams.get('learner');
    const sub = graph.around(aroundId, depth, cap);
    const mastery = learner ? snapshot(await learnerStore().get(learner)) : {};
    json(res, 200, { root: aroundId, ...sub, mastery });
    return true;
  }

  /* ---- 学生的掌握度 + 下一步学什么 ---- */
  const learnerId = seg('/kg/mastery/');
  if (learnerId && req.method === 'GET') {
    const state = await learnerStore().get(learnerId);
    const snap = snapshot(state);
    const named = Object.entries(snap).map(([id, v]) => ({
      id,
      name: graph.get(id)?.name ?? id,
      label: graph.get(id)?.label,
      ...v,
      attempts: state.mastery[id]?.attempts ?? 0,
      correct: state.mastery[id]?.correct ?? 0,
      lastSeen: state.mastery[id]?.lastSeen ?? 0,
    }));
    named.sort((a, b) => a.level - b.level);
    json(res, 200, {
      learnerId,
      updatedAt: state.updatedAt,
      counts: tally(named.map((n) => n.band)),
      mastery: named,
      next: recommend(graph, state, { limit: 6 }).map((r) => ({
        id: r.node!.id,
        name: r.node!.name,
        level: r.level,
        reason: r.reason,
      })),
    });
    return true;
  }

  /* ---- 写：辅导结束时把这次练到的知识点记进去 ---- */
  if (p === '/kg/attempts' && req.method === 'POST') {
    const body = await readJson(req);
    const learner = String((body as { learnerId?: unknown }).learnerId ?? '');
    const rawAttempts = (body as { attempts?: unknown }).attempts;
    if (!learner || !Array.isArray(rawAttempts)) {
      json(res, 400, { error: '需要 learnerId 和 attempts 数组' });
      return true;
    }

    const attempts = rawAttempts.map((a) => AttemptSchema.parse(a));
    // 图里没有的知识点不记：宁可少记，也不要在图谱上长出一堆幽灵节点
    const known = attempts.filter((a) => graph.has(a.conceptId));
    const unknown = attempts.filter((a) => !graph.has(a.conceptId)).map((a) => a.conceptId);

    const updated = await recordAttempts(learnerStore(), learner, known);
    log.info('kg.attempts', { learner, recorded: updated.length, skipped: unknown.length });

    json(res, 200, {
      learnerId: learner,
      updated: updated.map((m) => ({
        id: m.conceptId,
        name: graph.get(m.conceptId)?.name ?? m.conceptId,
        level: m.level,
        band: bandOf(m.level),
        attempts: m.attempts,
        correct: m.correct,
      })),
      ...(unknown.length > 0 ? { skippedUnknown: unknown } : {}),
    });
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    // 掌握度是会变的，缓存住只会让人看到旧的绿
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('请求体太大');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function tally(bands: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of bands) out[b] = (out[b] ?? 0) + 1;
  return out;
}
