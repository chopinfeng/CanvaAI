import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@canvai/protocol';

/**
 * "重新开始"到底重置了什么。
 *
 * 光清画布是不够的：Agent 的对话历史还在，它记得刚才讲过的整道题；
 * 辅导账本也还挂着。这两样不清掉，新一轮就是接着上一场演。
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'canvai-reset-'));
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

describe('会话重置', () => {
  it('清掉辅导账本和模式，画布不动', async () => {
    const room = await freshRoom('r1');
    room.scene.create([{ type: 'rect', id: 'sh_keep', x: 0, y: 0, w: 10, h: 10 }], {
      author: { id: 'u1', kind: 'user' },
    });
    room.session.mode = 'tutor';
    room.session.tutor = {
      goal: '给我讲这道题',
      outline: [{ text: '(1) 求 DF', done: true }],
      startedTurn: 1,
      pending: { question: 'DF?', answer: '12' },
      rightSince: 1, markedSinceAsk: false
    };
    room.session.selection = ['sh_keep'];

    room.resetSession();

    expect(room.session.mode).toBe('assist');
    expect(room.session.tutor).toBeNull();
    expect(room.session.selection).toEqual([]);
    // 画布是用户的东西，重置会话不该碰它
    expect(room.scene.size).toBe(1);
    expect(room.scene.has('sh_keep')).toBe(true);
  });

  it('通知各端把聊天记录、清单、高亮一并清掉', async () => {
    const room = await freshRoom('r2');
    const seen: ServerMessage[] = [];
    const spy = vi.spyOn(room, 'broadcastControl').mockImplementation((m) => {
      seen.push(m);
    });

    room.resetSession();
    spy.mockRestore();

    expect(seen.map((m) => m.t)).toContain('session.reset');
    const todo = seen.find((m) => m.t === 'agent.todo');
    expect(todo && 'items' in todo ? todo.items : null).toEqual([]);
    const hl = seen.find((m) => m.t === 'agent.highlight');
    expect(hl && 'shapeIds' in hl ? hl.shapeIds : null).toEqual([]);
  });

  it('重置之后不会有半路的辅导账本残留下来', async () => {
    const room = await freshRoom('r3');
    room.session.mode = 'tutor';
    room.session.tutor = { goal: 'x', outline: [{ text: 'a', done: false }], startedTurn: 1, pending: null, rightSince: 0, markedSinceAsk: false };

    room.resetSession();
    room.resetSession(); // 重置两次也不该炸

    expect(room.session.tutor).toBeNull();
  });
});
