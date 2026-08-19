import type { Attempt, LearnerState, Mastery } from './schema.js';
import type { KnowledgeGraph } from './graph.js';

/**
 * 掌握度怎么算。
 *
 * 三条不肯让步的性质，其余都可以调：
 *
 * 1. **被引导着做对 ≠ 会了。** 辅导模式下学生是被一路问出来的，
 *    把它和独立做对记一样的分，图谱三天就变成一片虚假的绿。
 *    所以 guided 的加成砍掉大半。
 * 2. **会了也会忘。** 隔了很久没碰的知识点要往回滑，
 *    否则"上学期学过"永远显示为掌握，复习就无从谈起。
 * 3. **错一次的代价大于对一次的收益。** 学习曲线本来就不对称：
 *    栽一跤说明理解有洞，比多做对一道题的信息量大。
 */

/** 独立做对一次的增量 */
const GAIN_SOLO = 0.28;
/** 被引导着做对——给，但给得少 */
const GAIN_GUIDED = 0.12;
/**
 * 被引导着做对，最多只能到这儿。
 *
 * 光靠"给得少"不够：给得再少，被问出来五六次也照样累加到"已掌握"，
 * 图谱就又变成一片假的绿。真实情况是——被人一路问着走通，
 * 最多说明"跟得上"，不等于"自己能做"。跨过掌握线这一步，
 * 必须由他独立做对来完成。
 */
const GUIDED_CEIL = 0.55;
/** 做错的扣减 */
const LOSS = 0.34;
/** 半衰期：多久没碰，掌握度往"没把握"退一半 */
const HALF_LIFE_MS = 21 * 24 * 3600_000;

/** 0.6 以上算基本掌握，0.3 以下算薄弱 */
export const MASTERED = 0.6;
export const SHAKY = 0.3;

export function emptyLearner(learnerId: string): LearnerState {
  return { learnerId, mastery: {}, updatedAt: 0 };
}

/**
 * 把掌握度按时间衰减到 `now`。
 *
 * 往 0.5（说不好）退，不是往 0 退——很久没碰不等于不会了，
 * 只是不确定了。退到 0 会让复习建议全是些其实早就会的东西。
 */
export function decayed(m: Mastery, now: number): number {
  const dt = Math.max(0, now - m.lastSeen);
  const k = Math.pow(0.5, dt / HALF_LIFE_MS);
  return 0.5 + (m.level - 0.5) * k;
}

/** 记一次练习。返回更新后的那条（原对象不动） */
export function record(state: LearnerState, a: Attempt): Mastery {
  const now = a.at || Date.now();
  const prev = state.mastery[a.conceptId];
  const base = prev ? decayed(prev, now) : 0.35; // 没见过的从"略偏不会"起步

  const delta = a.ok ? (a.guided ? GAIN_GUIDED : GAIN_SOLO) : -LOSS;
  // 引导着做对：涨可以涨，但顶到 GUIDED_CEIL 为止。
  // 用 max(base, ...) 是为了别把早先独立做对挣来的高分反而拉下来。
  const raised = a.ok && a.guided ? Math.max(base, Math.min(base + delta, GUIDED_CEIL)) : base + delta;

  const next: Mastery = {
    conceptId: a.conceptId,
    level: clamp(raised),
    attempts: (prev?.attempts ?? 0) + 1,
    correct: (prev?.correct ?? 0) + (a.ok ? 1 : 0),
    lastSeen: now,
    lastOk: a.ok,
  };

  state.mastery[a.conceptId] = next;
  state.updatedAt = now;
  return next;
}

export function recordAll(state: LearnerState, attempts: Attempt[]): Mastery[] {
  return attempts.map((a) => record(state, a));
}

export type Band = 'mastered' | 'learning' | 'shaky' | 'unseen';

export function bandOf(level: number | undefined): Band {
  if (level === undefined) return 'unseen';
  if (level >= MASTERED) return 'mastered';
  if (level <= SHAKY) return 'shaky';
  return 'learning';
}

/** 当前（衰减到 now 之后）的掌握度快照 */
export function snapshot(state: LearnerState, now = Date.now()): Record<string, { level: number; band: Band }> {
  const out: Record<string, { level: number; band: Band }> = {};
  for (const [id, m] of Object.entries(state.mastery)) {
    const level = clamp(decayed(m, now));
    out[id] = { level, band: bandOf(level) };
  }
  return out;
}

/**
 * 下一步该学什么。
 *
 * 规则很朴素，但顺序是有讲究的：
 * **先补洞，再往前走。** 一个知识点自己薄弱，或者它的前置薄弱，
 * 那就别急着解锁新的——地基没打好往上垒，只会在更靠后的地方塌。
 */
export function recommend(
  graph: KnowledgeGraph,
  state: LearnerState,
  opts: { limit?: number; now?: number } = {},
): Array<{ node: ReturnType<KnowledgeGraph['get']>; reason: string; level: number; priority: number }> {
  const now = opts.now ?? Date.now();
  const snap = snapshot(state, now);
  const out: Array<{ node: ReturnType<KnowledgeGraph['get']>; reason: string; level: number; priority: number }> = [];

  for (const [id, { level, band }] of Object.entries(snap)) {
    const node = graph.get(id);
    if (!node) continue;

    if (band === 'shaky') {
      out.push({ node, level, reason: '这个知识点还很薄弱，先把它补上', priority: 3 + (SHAKY - level) });
      continue;
    }

    // 自己还行，但前置里有洞——那才是真正该先修的地方
    const weakPre = graph
      .prerequisites(id, 1)
      .map((p) => ({ p, lv: snap[p.node.id]?.level }))
      .filter((x) => x.lv !== undefined && x.lv <= SHAKY);
    if (weakPre.length > 0) {
      const first = weakPre[0]!;
      out.push({
        node: first.p.node,
        level: first.lv!,
        reason: `${node.name}要用到它，但这一块还不稳`,
        priority: 2.5,
      });
      continue;
    }

    if (band === 'mastered') {
      for (const nx of graph.unlocks(id, 1)) {
        if (snap[nx.node.id]) continue; // 已经在学了
        out.push({ node: nx.node, level: 0, reason: `${node.name}你已经会了，接着可以学这个`, priority: 1 });
      }
    }
  }

  // 同一个知识点可能从几条路推荐进来，留优先级最高的那次
  const best = new Map<string, (typeof out)[number]>();
  for (const r of out) {
    const id = r.node!.id;
    const cur = best.get(id);
    if (!cur || r.priority > cur.priority) best.set(id, r);
  }

  return [...best.values()].sort((a, b) => b.priority - a.priority).slice(0, opts.limit ?? 8);
}

const clamp = (v: number): number => Math.min(1, Math.max(0, v));
