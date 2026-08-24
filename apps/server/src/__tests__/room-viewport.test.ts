import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeFrame, FrameTag } from '@canvai/protocol';
import type { ServerMessage } from '@canvai/protocol';

/**
 * 打开一个已经有内容的房间，镜头要落在内容上。
 *
 * 真机反馈过：手工灌好题目的房间（不走 paper.ts 那条导入路径），
 * 默认相机停在 (0,0,zoom:1)，题目文字从 x=80 起笔，用户打开页面
 * 看到的是一片空白——这条路径 paper.ts 的 agent.viewport 修复完全
 * 没覆盖到，因为那次修复只在"导入"那一刻发一次消息，跟这里的
 * "打开一个已有内容的房间"是两件事。
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'canvai-room-viewport-'));
  process.env.DATA_DIR = dataDir;
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

/** 假 WebSocket：只记录发出去的帧，解出其中的控制消息 */
function fakeSocket() {
  const sent: Uint8Array[] = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (data: Uint8Array) => sent.push(data),
  };
  const controlMessages = (): ServerMessage[] =>
    sent
      .map((bytes) => decodeFrame(bytes))
      .filter((f) => f.tag === FrameTag.Control)
      .map((f) => JSON.parse(new TextDecoder().decode(f.payload)) as ServerMessage);
  return { socket: socket as unknown as import('ws').WebSocket, controlMessages };
}

describe('打开有内容的房间，镜头自动落到内容上', () => {
  it('房间里有图元 → join 时发一条 agent.viewport，覆盖全部内容', async () => {
    const room = await freshRoom('r1');
    room.scene.create(
      [
        { type: 'text', id: 'sh_a', x: 80, y: 80, text: '题目' },
        { type: 'text', id: 'sh_b', x: 400, y: 300, text: '(1) 问' },
      ],
      { author: { id: 'u1', kind: 'user' } },
    );

    const { socket, controlMessages } = fakeSocket();
    room.join(socket, { id: 'u1', name: '用户', color: '#000' });

    const viewport = controlMessages().find((m) => m.t === 'agent.viewport');
    expect(viewport).toBeDefined();
    expect(viewport!.animate).toBe(false);
    const [vx, vy, vw, vh] = viewport!.rect!;
    // 两个图元都要落在这个视口范围内
    expect(vx).toBeLessThanOrEqual(80);
    expect(vy).toBeLessThanOrEqual(80);
    expect(vx + vw).toBeGreaterThanOrEqual(400);
    expect(vy + vh).toBeGreaterThanOrEqual(300);
  });

  it('房间是空的 → 不发这条消息，没什么可对准的', async () => {
    const room = await freshRoom('r2');
    const { socket, controlMessages } = fakeSocket();

    room.join(socket, { id: 'u1', name: '用户', color: '#000' });

    expect(controlMessages().find((m) => m.t === 'agent.viewport')).toBeUndefined();
  });
});
