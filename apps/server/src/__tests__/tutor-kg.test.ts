import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "学生学会了什么"这条链路，端到端。
 *
 * 拆题 → 从小问里认出知识点 → 判定 → 落盘 → 读回掌握度。
 *
 * 用确定性的方式验，不靠跑一整场模型驱动的辅导：那条路上失败原因每次都不同
 * （模型空转、意图没识别、握手丢包），而这条链路本身是死的还是活的
 * 跟模型状态无关。事实上它**曾经整场是死的而没人发现**——
 * KnowledgePort.search 在图谱没装载时静默返回空数组，而 Agent 那条路
 * 从来不触发装载，于是七次判定一个知识点都没记上，判分表只说
 * "多半是模型没带 conceptIds"。这条测试就是为了那种情况不再无声无息。
 */

// vitest 从仓库根跑（根 vitest.config.ts），所以 cwd 就是仓库根
const KG_DIR = join(process.cwd(), 'data', 'kg');

async function hasData(): Promise<boolean> {
  try {
    await readFile(join(KG_DIR, 'math.json'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'canvai-tutorkg-'));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();

  /**
   * 图谱和学习记录都住在 DATA_DIR 底下。
   *
   * 学习记录必须写到临时目录（不然测试会往仓库的 data/ 里塞垃圾），
   * 但图谱得是**真的那一份**——这条链路的价值就在于它跑在真实数据上：
   * "勾股定理"认不认得出来，取决于人教版八下那册里到底有没有这个节点。
   * 拿手编的假图谱验，验的是我自己的想象。
   */
  if (await hasData()) {
    await mkdir(join(dataDir, 'kg'), { recursive: true });
    await cp(KG_DIR, join(dataDir, 'kg'), { recursive: true });
  }
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

describe('辅导一场之后，图谱上要长出东西', () => {
  it('小问里的知识点被认出来、判定被记下、掌握度读得回来', async () => {
    // K12-KGraph 数据是 CC BY-NC-SA，不入库；没下载就跳过，别挡着别人跑测试。
    // 但**要说出来**——静默跳过的测试和通过的测试在输出里长得一模一样，
    // 而这整轮排查的主题就是"静默的失败最难查"。
    if (!(await hasData())) {
      console.warn(`跳过：${KG_DIR} 下没有图谱数据，这条链路没被验到`);
      return;
    }

    const { loadGraph, makeKnowledgePort, learnerStore } = await import('../knowledge.ts');
    await loadGraph();

    const kp = makeKnowledgePort('learner-under-test');

    // 1) 从一整句小问里认出知识点——这是 search 做不到的那一步
    const hits = kp.mentions('在两个直角三角形里分别用勾股定理写出 AD²', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.name)).toContain('勾股定理');

    // 2) 判定落盘
    const ids = hits.map((h) => h.id);
    await kp.record(ids.map((conceptId) => ({ conceptId, ok: true, guided: true })));

    // 3) 读得回来，而且记的是"被引导着做对"，不是独立掌握
    const state = await learnerStore().get('learner-under-test');
    const got = ids.map((id) => state.mastery[id]).filter(Boolean);
    expect(got.length).toBe(ids.length);
    for (const m of got) {
      expect(m!.attempts).toBe(1);
      expect(m!.correct).toBe(1);
    }

    // 再答对一次，分要往上走——不然"学了"和"没学"在数据上没区别
    const before = got.map((m) => m!.level);
    await kp.record(ids.map((conceptId) => ({ conceptId, ok: true, guided: true })));
    const state2 = await learnerStore().get('learner-under-test');
    ids.forEach((id, i) => {
      expect(state2.mastery[id]!.level).toBeGreaterThan(before[i]!);
    });

    /**
     * 但一路被问出来的，涨到 GUIDED_CEIL 就封顶，永远够不着 0.6「基本掌握」。
     * 这条是整个掌握度模型的立场：被老师一步步问出来的答案，
     * 不能和自己独立做对记一样的分。少了它，图谱只是个好看的装饰。
     */
    for (let i = 0; i < 12; i++) {
      await kp.record(ids.map((conceptId) => ({ conceptId, ok: true, guided: true })));
    }
    const state3 = await learnerStore().get('learner-under-test');
    for (const id of ids) {
      expect(state3.mastery[id]!.level).toBeLessThanOrEqual(0.55);
    }
  }, 30_000);

  it('图里没有的 id 不落盘——别在图谱上长出幽灵节点', async () => {
    if (!(await hasData())) {
      console.warn(`跳过：${KG_DIR} 下没有图谱数据，这条链路没被验到`);
      return;
    }

    const { loadGraph, makeKnowledgePort, learnerStore } = await import('../knowledge.ts');
    await loadGraph();
    const kp = makeKnowledgePort('ghost-test');

    await kp.record([{ conceptId: 'concept_that_does_not_exist', ok: true, guided: true }]);

    const state = await learnerStore().get('ghost-test');
    expect(Object.keys(state.mastery)).toHaveLength(0);
  }, 30_000);
});
