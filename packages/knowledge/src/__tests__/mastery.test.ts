import { describe, expect, it } from 'vitest';
import { KnowledgeGraph } from '../graph.js';
import { MASTERED, SHAKY, bandOf, decayed, emptyLearner, record, recommend, snapshot } from '../mastery.js';

/**
 * 掌握度的三条性质。
 *
 * 这三条不是审美偏好，是"图谱到底有没有用"的分界线：
 * 少了任何一条，图谱都会变成一片和真实水平无关的绿。
 */

const DAY = 24 * 3600_000;
const T0 = 1_700_000_000_000;

describe('被引导着做对 ≠ 会了', () => {
  it('独立做对涨得多，被引导着做对涨得少', () => {
    const solo = emptyLearner('a');
    const guided = emptyLearner('b');

    record(solo, { conceptId: 'c1', ok: true, guided: false, at: T0 });
    record(guided, { conceptId: 'c1', ok: true, guided: true, at: T0 });

    expect(solo.mastery.c1!.level).toBeGreaterThan(guided.mastery.c1!.level);
  });

  it('全靠引导做对，做几次都到不了"掌握"——被问出来五六次也一样', () => {
    const s = emptyLearner('a');
    for (let i = 0; i < 8; i++) {
      record(s, { conceptId: 'c1', ok: true, guided: true, at: T0 + i * 1000 });
    }
    // 光靠"涨得少"挡不住累加，得有个天花板
    expect(s.mastery.c1!.level).toBeLessThan(MASTERED);
  });

  it('已经独立掌握了，之后又被引导着做对，不该反过来把分拉低', () => {
    const s = emptyLearner('a');
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 });
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 + 1000 });
    const solo = s.mastery.c1!.level;

    record(s, { conceptId: 'c1', ok: true, guided: true, at: T0 + 2000 });
    expect(s.mastery.c1!.level).toBeGreaterThanOrEqual(solo - 0.001);
  });

  it('自己做对两次就够得着"掌握"', () => {
    const s = emptyLearner('a');
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 });
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 + 1000 });
    expect(s.mastery.c1!.level).toBeGreaterThanOrEqual(MASTERED);
  });
});

describe('会了也会忘', () => {
  it('隔得越久，掌握度越往"说不好"退', () => {
    const s = emptyLearner('a');
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 });
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 + 1000 });
    const fresh = s.mastery.c1!.level;

    const after3w = decayed(s.mastery.c1!, T0 + 21 * DAY);
    const after3m = decayed(s.mastery.c1!, T0 + 90 * DAY);

    expect(after3w).toBeLessThan(fresh);
    expect(after3m).toBeLessThan(after3w);
  });

  it('退向"说不好"而不是"不会"——很久没碰不等于忘光了', () => {
    const s = emptyLearner('a');
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 });
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 + 1000 });

    const after1y = decayed(s.mastery.c1!, T0 + 365 * DAY);
    expect(after1y).toBeGreaterThan(0.45);
    expect(after1y).toBeLessThan(0.6);
  });
});

describe('错一次的代价大于对一次的收益', () => {
  it('对一次再错一次，比没做过还低', () => {
    const s = emptyLearner('a');
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 });
    const afterRight = s.mastery.c1!.level;
    record(s, { conceptId: 'c1', ok: false, guided: false, at: T0 + 1000 });

    expect(s.mastery.c1!.level).toBeLessThan(afterRight);
    expect(s.mastery.c1!.level).toBeLessThan(0.35); // 起点是 0.35
  });

  it('答错会落进"薄弱"，正好是要复习的那一档', () => {
    const s = emptyLearner('a');
    record(s, { conceptId: 'c1', ok: false, guided: true, at: T0 });
    expect(bandOf(s.mastery.c1!.level)).toBe('shaky');
  });
});

describe('下一步学什么', () => {
  const g = new KnowledgeGraph();
  g.load({
    nodes: [
      { id: 'c1', label: 'Concept', name: '正数', properties: {} },
      { id: 'c2', label: 'Concept', name: '负数', properties: {} },
      { id: 'c3', label: 'Concept', name: '有理数', properties: {} },
    ],
    edges: [
      { source: 'c1', target: 'c2', type: 'prerequisites_for', properties: {} },
      { source: 'c2', target: 'c3', type: 'prerequisites_for', properties: {} },
    ],
  });

  it('先补洞：自己薄弱的排在最前面', () => {
    const s = emptyLearner('a');
    record(s, { conceptId: 'c2', ok: false, guided: true, at: T0 });

    const rec = recommend(g, s, { now: T0 + 1000 });
    expect(rec[0]!.node!.id).toBe('c2');
    expect(rec[0]!.reason).toContain('薄弱');
  });

  it('自己还行但前置有洞，先修前置——地基没打好往上垒只会在后面塌', () => {
    const s = emptyLearner('a');
    record(s, { conceptId: 'c1', ok: false, guided: true, at: T0 }); // 前置薄弱
    record(s, { conceptId: 'c2', ok: true, guided: false, at: T0 }); // 自己看着还行

    const rec = recommend(g, s, { now: T0 + 1000 });
    const first = rec[0]!;
    expect(first.node!.id).toBe('c1');
  });

  it('掌握了就往下解锁', () => {
    const s = emptyLearner('a');
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 });
    record(s, { conceptId: 'c1', ok: true, guided: false, at: T0 + 1000 });

    const rec = recommend(g, s, { now: T0 + 2000 });
    expect(rec.some((r) => r.node!.id === 'c2' && r.reason.includes('接着可以学'))).toBe(true);
  });
});

describe('快照', () => {
  it('分档给出来，可视化直接按档上色', () => {
    const s = emptyLearner('a');
    record(s, { conceptId: 'good', ok: true, guided: false, at: T0 });
    record(s, { conceptId: 'good', ok: true, guided: false, at: T0 + 1 });
    record(s, { conceptId: 'bad', ok: false, guided: false, at: T0 });

    const snap = snapshot(s, T0 + 2);
    expect(snap.good!.band).toBe('mastered');
    expect(snap.bad!.band).toBe('shaky');
    expect(snap.bad!.level).toBeLessThanOrEqual(SHAKY);
  });
});
