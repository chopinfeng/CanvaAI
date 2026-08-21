import { describe, expect, it } from 'vitest';
import { numbersIn, parseJson, score, type Truth } from '../bench-score.ts';

/**
 * 打分器自己得先靠得住。
 *
 * 它决定"视觉模型到底行不行"这个结论——错了的话给出的是一个
 * 理直气壮的错误判断，比没有基准更糟。所以这里用手写的提取结果喂它，
 * 每条都对着一个明确的判断。
 */

const G1: Truth = {
  id: 'G1',
  topic: '矩形折叠 / 勾股定理',
  statement: '矩形 ABCD 中，AB=13，AD=5。点 E 在边 BC 上……(1) 求 DF 与 FC 的长；(2) 求线段 BE 的长。',
  known: { AB: 13, AD: 5 },
  answer: 'DF=12，FC=1；BE=13/5',
};

describe('抠 JSON', () => {
  it('裹在 ```json 里也能拿出来', () => {
    const got = parseJson('好的，我看到：\n```json\n{"statement":"abc"}\n```\n希望有帮助');
    expect(got?.statement).toBe('abc');
  });

  it('前后有客套话的裸 JSON 也能拿出来', () => {
    expect(parseJson('这张图片包含：{"topic":"勾股定理"} 以上。')?.topic).toBe('勾股定理');
  });

  it('真的不是 JSON 就返回 null，别硬凑', () => {
    expect(parseJson('图片模糊，我看不清楚。')).toBeNull();
  });
});

describe('抓数字', () => {
  it('整数、小数、分数都抓得到', () => {
    expect([...numbersIn('AB=13，x=2.6，BE=13/5')]).toEqual(['13', '2.6', '13/5']);
  });
});

describe('已知量保真', () => {
  it('填进 known 对象算命中', () => {
    const s = score(G1, { known: { AB: 13, AD: 5 }, asks: ['求 DF'], topic: '勾股定理' });
    expect(s.knownHit).toBe(2);
  });

  it('只写在题干里的 "AB=13" 同样算命中——模型没义务按我们的结构填', () => {
    const s = score(G1, { statement: '矩形 ABCD 中，AB=13，AD=5。求 DF。', topic: '勾股定理' });
    expect(s.knownHit).toBe(2);
  });

  it('读错数值不算命中', () => {
    const s = score(G1, { known: { AB: 12, AD: 5 }, asks: ['求 DF'] });
    expect(s.knownHit).toBe(1);
    expect(s.ok).toBe(false);
  });

  it('known 里明确写了错值，就算题干里还留着对的数也不算命中', () => {
    // 负对照跑出来的洞：下游读的是 known 这个结构化字段，
    // 那里给了错值就是错值，题干里恰好还有对的数不能替它开脱
    const s = score(G1, { known: { AB: 12, AD: 5 }, statement: '矩形 ABCD 中，AB=13，AD=5。' });
    expect(s.knownHit).toBe(1);
  });

  it('模型没填 known 时才退回文本匹配——只写在题干里不代表读错了', () => {
    const s = score(G1, { known: { AD: 5 }, statement: '矩形 ABCD 中，AB=13。' });
    expect(s.knownHit).toBe(2);
  });

  it('数值是对的前缀也不能算命中（13 不该被 1 匹配上）', () => {
    const s = score({ ...G1, known: { AB: 1 } }, { statement: 'AB=13' });
    expect(s.knownHit).toBe(0);
  });
});

describe('数字幻觉——这条最要紧', () => {
  it('题目里没有的数要被抓出来', () => {
    const s = score(G1, {
      statement: '矩形 ABCD 中，AB=13，AD=5，BC=8。求 DF。',
      known: { AB: 13, AD: 5 },
    });
    expect(s.hallucinated).toContain('8');
    expect(s.ok).toBe(false); // 已知量全中也不算过——编了数就是不能用
  });

  it('题号和 (1)(2) 序号不算幻觉', () => {
    const s = score(G1, {
      statement: '(1) 求 DF 与 FC 的长；(2) 求线段 BE 的长。AB=13，AD=5',
      known: { AB: 13, AD: 5 },
    });
    expect(s.hallucinated).toEqual([]);
  });

  it('答案里出现过的数不算幻觉——模型顺手算出 12 是允许的', () => {
    const s = score(G1, { statement: 'AB=13，AD=5，可得 DF=12', known: { AB: 13, AD: 5 } });
    expect(s.hallucinated).toEqual([]);
  });
});

describe('所求与考点', () => {
  it('提到答案里的量名就算识别出所求', () => {
    expect(score(G1, { asks: ['求 DF 和 FC', '求 BE'] }).asksHit).toBe(true);
  });

  it('完全没提到所求的量名 → 未识别', () => {
    expect(score(G1, { asks: ['求这个图形的面积'] }).asksHit).toBe(false);
  });

  it('考点说法不同但抓到关键词就算', () => {
    expect(score(G1, { topic: '勾股定理的应用' }).topicHit).toBe(true);
    expect(score(G1, { topic: '一元二次方程' }).topicHit).toBe(false);
  });
});

describe('整题判定', () => {
  it('已知全中 + 所求识别 + 没编数字，才算这道题过', () => {
    const s = score(G1, {
      statement: '矩形 ABCD 中，AB=13，AD=5。(1) 求 DF 与 FC；(2) 求 BE。',
      known: { AB: 13, AD: 5 },
      asks: ['求 DF 与 FC', '求 BE'],
      topic: '矩形折叠',
    });
    expect(s.ok).toBe(true);
  });

  it('解析不出 JSON 时如实记成失败，并说清是解析问题', () => {
    const s = score(G1, null, 240);
    expect(s.ok).toBe(false);
    expect(s.note).toContain('没能解析');
  });
});
