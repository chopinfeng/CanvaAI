import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 画布列表要回答的是"哪张画布是哪张卷子"。
 *
 * 光给房间名回答不了：`ugrad` `ugrad-scan` `amc3` `drill-m2k9x` 摆在一起
 * 谁也认不出来。所以标题得从画布内容里读，而这段读取有几个必须守住的性质：
 * 坏快照不能让整张列表打不开，空画布不该占位置，最近用的要排前面。
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'canvai-rooms-'));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  await mkdir(join(dataDir, 'rooms'), { recursive: true });
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

/** 造一个真实的房间快照：建房间、放图元、落盘 */
async function makeRoom(id: string, shapes: Array<Record<string, unknown>>) {
  const { Room } = await import('../room.ts');
  const room = new Room(id);
  await room.load();
  if (shapes.length > 0) {
    room.scene.create(shapes as never, { author: { id: 'seed', kind: 'user' }, layer: 'user' });
  }
  await room.dispose();
}

const text = (x: number, y: number, s: string, role?: string) => ({
  type: 'text',
  x,
  y,
  text: s,
  ...(role ? { meta: { role } } : {}),
});

describe('画布列表', () => {
  // 这些用例会 vi.resetModules() 后重新 import room.ts —— 整个模块图（含 agent 包）
  // 要重新转译一遍，全量并跑时挤过默认的 5s。给足余量，别让它偶发红。
  it('标题取画布上第一段文字，用来认卷子', async () => {
    await makeRoom('r1', [text(80, 300, '第二段'), text(80, 80, 'Geometry — Triangle with an Altitude')]);
    const { listRooms } = await import('../rooms-index.ts');
    const got = await listRooms();
    expect(got.find((r) => r.id === 'r1')?.title).toBe('Geometry — Triangle with an Altitude');
  }, 30_000);

  it('有标题角色的优先，不管它排第几', async () => {
    await makeRoom('r2', [text(80, 40, '（自动识别）'), text(80, 200, '真正的标题', 'problem-title')]);
    const { listRooms } = await import('../rooms-index.ts');
    expect((await listRooms()).find((r) => r.id === 'r2')?.title).toBe('真正的标题');
  }, 30_000);

  it('多行的只取第一行——卡片上放不下整段题干', async () => {
    await makeRoom('r3', [text(80, 80, '第一行\n第二行\n第三行')]);
    const { listRooms } = await import('../rooms-index.ts');
    expect((await listRooms()).find((r) => r.id === 'r3')?.title).toBe('第一行');
  }, 30_000);

  it('空画布不占列表位置', async () => {
    await makeRoom('empty', []);
    await makeRoom('has', [text(80, 80, '有东西')]);
    const { listRooms } = await import('../rooms-index.ts');
    const ids = (await listRooms()).map((r) => r.id);
    expect(ids).toContain('has');
    expect(ids).not.toContain('empty');
  }, 30_000);

  it('坏快照照样出现在列表里，不能让整张列表打不开', async () => {
    // 磁盘上真的存在坏快照（room.snapshot_corrupt 就是为它加的）。
    // 那种房间要是从列表里消失，用户只会觉得自己的画布凭空没了。
    await makeRoom('good', [text(80, 80, '好的')]);
    await writeFile(join(dataDir, 'rooms', 'broken.ydoc'), Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]));
    const { listRooms } = await import('../rooms-index.ts');
    const got = await listRooms();
    expect(got.map((r) => r.id)).toContain('good');
    const bad = got.find((r) => r.id === 'broken');
    expect(bad?.title).toContain('读不出来');
  }, 30_000);

  it('最近改过的排最前——按名字排的话刚建的会沉在中间', async () => {
    await makeRoom('old', [text(80, 80, '旧的')]);
    await new Promise((r) => setTimeout(r, 30));
    await makeRoom('new', [text(80, 80, '新的')]);
    const { listRooms } = await import('../rooms-index.ts');
    const ids = (await listRooms()).map((r) => r.id);
    expect(ids.indexOf('new')).toBeLessThan(ids.indexOf('old'));
  }, 30_000);
});
