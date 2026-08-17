import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 持久化是"用户的画会不会没"的最后一道防线，所以单独测。
 *
 * config 依赖环境变量，用 vi.resetModules + 改 env 的方式，
 * 每个用例拿到一个隔离的 dataDir。
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'canvai-test-'));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATA_DIR;
});

async function freshRoom(id: string) {
  const { Room } = await import('../room.ts');
  const room = new Room(id);
  await room.load();
  return room;
}

const roomFile = (id: string) => join(dataDir, 'rooms', `${id}.ydoc`);

describe('房间快照', () => {
  it('存了能读回来', async () => {
    const a = await freshRoom('r1');
    a.scene.create([{ type: 'rect', id: 'sh_keep', x: 10, y: 20, w: 30, h: 40 }], {
      author: { id: 'u1', kind: 'user' },
    });
    await a.save();

    vi.resetModules();
    const b = await freshRoom('r1');
    expect(b.scene.size).toBe(1);
    expect(b.scene.get('sh_keep')!.w).toBe(30);
  });

  it('写入是原子的：不留半截文件，也不留临时文件', async () => {
    const room = await freshRoom('r2');
    room.scene.create([{ type: 'rect', x: 0, y: 0, w: 5, h: 5 }], { author: { id: 'u1', kind: 'user' } });
    await room.save();

    const files = await readdir(join(dataDir, 'rooms'));
    expect(files).toEqual(['r2.ydoc']); // 没有遗留的 .tmp
  });

  it('快照损坏时备份原件，并且拒绝用空文档覆盖它', async () => {
    // 先存一份真实内容
    const a = await freshRoom('r3');
    a.scene.create([{ type: 'rect', x: 1, y: 2, w: 3, h: 4 }], { author: { id: 'u1', kind: 'user' } });
    await a.save();
    const good = await readFile(roomFile('r3'));

    // 模拟进程被杀导致的截断
    await writeFile(roomFile('r3'), good.subarray(0, Math.max(1, good.length - 6)));
    const truncated = await readFile(roomFile('r3'));

    vi.resetModules();
    const b = await freshRoom('r3');

    // 这是关键：即使随后又触发保存，磁盘上的文件也不能被空文档覆盖
    await b.save();
    expect(await readFile(roomFile('r3'))).toEqual(truncated);

    // 原件另存了一份，便于人工抢救
    const files = await readdir(join(dataDir, 'rooms'));
    expect(files.some((f) => f.startsWith('r3.ydoc.corrupt.'))).toBe(true);
  });

  it('房间不存在时是正常的新房间，不算损坏', async () => {
    const room = await freshRoom('never-seen');
    expect(room.scene.size).toBe(0);
    room.scene.create([{ type: 'rect', x: 0, y: 0, w: 1, h: 1 }], { author: { id: 'u1', kind: 'user' } });
    await room.save();
    expect((await readFile(roomFile('never-seen'))).length).toBeGreaterThan(0);
  });

  it('saveAllRooms 会保存正在被使用的房间，而不只是空房间', async () => {
    const { getRoom, saveAllRooms } = await import('../room.ts');
    const room = await getRoom('busy');
    // 装作有人连着（CLOSED 状态，广播会跳过它）
    const fakeSocket = { readyState: 3, OPEN: 1, send() {} };
    (room as unknown as { clients: Map<unknown, unknown> }).clients.set(fakeSocket, {
      id: 'c1',
      socket: fakeSocket,
      user: { id: 'u1', name: '我', color: '#000' },
    });
    expect(room.clientCount).toBe(1);

    room.scene.create([{ type: 'ellipse', x: 0, y: 0, w: 9, h: 9 }], { author: { id: 'u1', kind: 'user' } });
    await saveAllRooms();

    vi.resetModules();
    const reloaded = await freshRoom('busy');
    expect(reloaded.scene.size).toBe(1);
  });
});
