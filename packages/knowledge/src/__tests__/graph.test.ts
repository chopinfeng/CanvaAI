import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeGraph } from '../graph.js';

/**
 * 用真实的 K12-KGraph 分册测，不用手编的假数据。
 *
 * 理由是这一轮踩的坑：文档写的边是 source/target 一对一，
 * 实际数据里「这道题考了哪些知识点」是一对多（没有 target，
 * 改用 target_name_to_ids 装一串）——285 条边里有 32 条是这样，
 * 而且恰好是最要紧的那一类。照文档写的解析会一条数据都进不来。
 * 所以这里读真文件；没下载数据时跳过，不阻塞别人跑测试。
 */

const FILE = join(process.cwd(), 'data', 'kg', 'math_7a_rjb.json');

async function realGraph(): Promise<KnowledgeGraph | null> {
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8')) as unknown;
    const g = new KnowledgeGraph();
    g.load(raw);
    return g;
  } catch {
    return null;
  }
}

describe('装真实教材数据', () => {
  it('人教七上数学整册进得来，一条都不该丢', async () => {
    const g = await realGraph();
    if (!g) return; // 没跑 fetch-kg，跳过
    const s = g.stats();

    expect(s.nodes).toBe(157);
    expect(s.byLabel.Concept).toBe(94);
    expect(s.subjects).toContain('数学');
    // 285 条原始边里 32 条是一对多，摊平后比原始条数多
    expect(s.edges).toBeGreaterThan(285);
  });

  it('一对多的「题目考哪些知识点」被摊平了——这是最要紧的一类边', async () => {
    const g = await realGraph();
    if (!g) return;

    const exercises = g.byLabel('Exercise');
    expect(exercises.length).toBeGreaterThan(0);

    // 至少有一道题挂着不止一个知识点，说明摊平确实生效了
    const multi = exercises.map((e) => g.conceptsOfExercise(e.id)).filter((cs) => cs.length > 1);
    expect(multi.length).toBeGreaterThan(0);
  });

  it('前置关系走得通：找得到"负数"要先会什么', async () => {
    const g = await realGraph();
    if (!g) return;

    const neg = g.search('负数', { label: 'Concept' })[0];
    expect(neg).toBeDefined();

    const pre = g.prerequisites(neg!.id, 2);
    // 有前置就该带着 evidence——选这份图谱就是为了每条边说得出依据
    if (pre.length > 0) {
      expect(pre[0]!.node.name).toBeTruthy();
      expect(pre[0]!.depth).toBe(0);
    }
  });
});

describe('查询', () => {
  const g = new KnowledgeGraph();
  g.load({
    nodes: [
      { id: 'c1', label: 'Concept', name: '正数', properties: { definition: '大于0的数' } },
      { id: 'c2', label: 'Concept', name: '负数', properties: {} },
      { id: 'c3', label: 'Concept', name: '有理数', properties: {} },
      { id: 'e1', label: 'Exercise', name: '第1题', properties: { stem: '写出体重增长值' } },
      { id: 'bad', label: 'Concept' }, // 缺 name，该被跳过
    ],
    edges: [
      { source: 'c1', target: 'c2', type: 'prerequisites_for', properties: {} },
      { source: 'c2', target: 'c3', type: 'prerequisites_for', properties: {} },
      { source: 'e1', type: 'tests_concept', target_name_to_ids: [{ target: 'c1' }, { target: 'c2' }] },
    ],
  });

  it('坏节点跳过，其余照进', () => {
    expect(g.size.nodes).toBe(4);
    expect(g.has('bad')).toBe(false);
  });

  it('一对多的边摊成两条', () => {
    expect(g.conceptsOfExercise('e1').map((n) => n.name)).toEqual(['正数', '负数']);
  });

  it('前置按层返回，近的在前', () => {
    const pre = g.prerequisites('c3', 2);
    expect(pre.map((p) => [p.depth, p.node.name])).toEqual([
      [0, '负数'],
      [1, '正数'],
    ]);
  });

  it('会了这个之后能学什么', () => {
    expect(g.unlocks('c1', 1).map((u) => u.node.name)).toEqual(['负数']);
  });

  it('精确命中排在包含匹配前面', () => {
    const hits = g.search('数');
    expect(hits.length).toBeGreaterThan(1);
    const exact = g.search('正数');
    expect(exact[0]!.name).toBe('正数');
  });

  it('铺开子图时带上连接它们的边', () => {
    const sub = g.around('c2', 2);
    expect(sub.nodes.map((n) => n.id).sort()).toEqual(['c1', 'c2', 'c3', 'e1']);
    expect(sub.edges.length).toBeGreaterThan(0);
  });
});

/**
 * mentions：拿节点名去一段话里找，方向和 search 相反。
 *
 * 这个方法是被实测逼出来的。辅导拆出来的小问是**整句话**，而 search 是
 * 拿查询串去匹配节点名——「在两个直角三角形里分别用勾股定理写出 AD²」
 * 返回空，「勾股定理」返回六条。用 search 去认小问，一个知识点都认不出来，
 * 于是整条掌握度主线死了一整场都没人发现。
 */
describe('从一整句话里认出知识点', () => {
  const g = () => {
    const kg = new KnowledgeGraph();
    kg.load({
      nodes: [
        { id: 'c1', label: 'Concept', name: '勾股定理', properties: { aliases: ['Pythagoras theorem'] } },
        { id: 'c2', label: 'Concept', name: '勾股定理的逆定理', properties: {} },
        { id: 'c3', label: 'Concept', name: '直角三角形', properties: {} },
        { id: 'c4', label: 'Concept', name: '角', properties: {} },
        { id: 'c5', label: 'Concept', name: '直流电流', properties: { aliases: ['DC'] } },
        { id: 's1', label: 'Section', name: '第一节 勾股定理', properties: {} },
      ],
      edges: [],
    });
    return kg;
  };

  it('整句话里的知识点认得出来——search 在这种输入上一条都返回不了', () => {
    const got = g().mentions('在两个直角三角形里分别用勾股定理写出 AD²');
    expect(got.map((n) => n.name)).toContain('勾股定理');
    expect(got.map((n) => n.name)).toContain('直角三角形');
  });

  it('英文别名也认，但要卡词边界', () => {
    expect(g().mentions('use the Pythagoras theorem here').map((n) => n.id)).toContain('c1');
  });

  it('短的英文缩写不算数——几何题里的 DC 是线段，不是直流电', () => {
    // 实测踩到的：「解方程求出 BD 和 DC」命中了直流电流，
    // 学生会因为做了一道三角形的题被判定"掌握了直流电"
    expect(g().mentions('解方程求出 BD 和 DC').map((n) => n.name)).not.toContain('直流电流');
  });

  it('一个字的名字不算数——「角」在任何几何题里都出现，记了等于没记', () => {
    expect(g().mentions('这个角是多少度').map((n) => n.name)).not.toContain('角');
  });

  it('被更长的命中包住的短名字要让位——记「逆定理」就别再记「勾股定理」', () => {
    const got = g().mentions('用勾股定理的逆定理判断');
    expect(got.map((n) => n.name)).toEqual(['勾股定理的逆定理']);
  });

  it('只认知识点，不认章节——记「第一节」的掌握度没有意义', () => {
    expect(g().mentions('第一节 勾股定理讲了什么').map((n) => n.label)).not.toContain('Section');
  });
});
