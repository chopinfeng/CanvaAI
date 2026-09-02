/**
 * 灌一道本科题：二阶非齐次常微分方程，共振情形。
 *
 * 比拉格朗日乘数法那道题（seed-u8.ts）板书量更大：那道题三问加起来
 * 也就三四行代数。这道题真要按老师板书的节奏走下来，至少有这么几块
 * 分明的板书内容——特征方程、齐次通解、"右端和齐次解撞上了"这个
 * 共振判断、特解的正确设法（多乘一个 x）、把设的特解代回原方程求
 * 待定系数、最后代入初值条件解 C1、C2——每一块都有自己的推导，
 * 不是三言两语能糊弄过去的，天然逼着模型多写、多算。
 *
 * 用法：npx tsx scripts/seed-u10.ts [roomId]
 */
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Scene } from '@canvai/canvas-core';
import type { ShapeInput } from '@canvai/protocol';
import { FrameTag, decodeFrame, encodeFrame } from '@canvai/protocol';

const roomId = process.argv[2] ?? 'u10';
const PORT = process.env.PORT ?? '3001';

const INK = '#1c1917';
const MUTED = '#78716c';
const ACCENT = '#2563eb';

const t = (x: number, y: number, s: string, size: number, color = INK, role = 'text'): ShapeInput => ({
  type: 'text',
  x,
  y,
  text: s,
  style: { stroke: color, fontSize: size },
  meta: { role },
});

function build(): ShapeInput[] {
  const shapes: ShapeInput[] = [];

  shapes.push(t(80, 80, '常微分方程 — 二阶非齐次（共振情形）', 20, ACCENT, 'problem-title'));
  shapes.push(t(80, 112, '本科 · 较难 · 3 问', 12.5, MUTED, 'section-label'));

  const stmt = [
    '求解初值问题 y″ − 3y′ + 2y = 2eˣ，y(0) = 0，y′(0) = 1。',
    '',
    '(1) 求齐次方程的通解；',
    '(2) 注意右端 2eˣ 与齐次解的关系，给出特解的正确设法并求出特解；',
    '(3) 由初始条件定出待定常数，写出满足初值的解。',
  ].join('\n');
  shapes.push(t(80, 150, stmt, 15.5, INK, 'statement'));

  shapes.push(t(80, 320, '每一问都要写出推导过程，第 (2) 问尤其要说清楚为什么不能直接设 y=Aeˣ。', 13, MUTED, 'hint'));

  return shapes;
}

/* ------------------------------------------------------------------ */

const doc = new Y.Doc();
const scene = new Scene(doc);
const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${roomId}&uid=seed&name=%E5%8D%B7%E5%AD%90`);
ws.binaryType = 'arraybuffer';
const send = (tag: number, payload: Uint8Array) => ws.send(encodeFrame(tag as 0 | 1 | 2 | 3, payload));

doc.on('update', (update: Uint8Array, origin: unknown) => {
  if (origin === 'remote') return;
  const enc = encoding.createEncoder();
  syncProtocol.writeUpdate(enc, update);
  send(FrameTag.Sync, encoding.toUint8Array(enc));
});

let done = false;
let gotServerState = false;
let settle: NodeJS.Timeout | null = null;

function askForState(): void {
  const enc = encoding.createEncoder();
  syncProtocol.writeSyncStep1(enc, doc);
  send(FrameTag.Sync, encoding.toUint8Array(enc));
}

ws.on('open', () => {
  askForState();

  let tries = 0;
  const retry = setInterval(() => {
    if (done || gotServerState) return clearInterval(retry);
    if (++tries > 7) {
      clearInterval(retry);
      console.error(
        `重发了 ${tries - 1} 次握手也没收到房间「${roomId}」的状态。\n` +
          `服务端在跑吗？ curl http://localhost:${PORT}/health`,
      );
      process.exit(1);
    }
    askForState();
  }, 2000);
});

ws.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
  const { tag, payload } = decodeFrame(bytes);
  if (tag !== FrameTag.Sync) return;
  const dec = decoding.createDecoder(payload);
  const enc = encoding.createEncoder();
  const kind = syncProtocol.readSyncMessage(dec, enc, doc, 'remote');
  if (kind !== syncProtocol.messageYjsSyncStep1) gotServerState = true;
  if (encoding.length(enc) > 0) send(FrameTag.Sync, encoding.toUint8Array(enc));
  if (done) return;

  if (!gotServerState) return;
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    if (done) return;
    done = true;

    const all = scene.all();
    if (all.length > 0) {
      scene.delete(all.map((s) => s.id));
      console.log(`清掉旧的 ${all.length} 个图元`);
    }
    ws.send(encodeFrame(FrameTag.Control, new TextEncoder().encode(JSON.stringify({ t: 'session.reset' }))));

    const shapes = build();
    scene.create(shapes, { author: { id: 'seed', kind: 'user', name: '卷子' } });
    console.log(`已向房间「${roomId}」注入 1 道题（3 问），${shapes.length} 个图元`);
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 1200);
  }, 400);
});

ws.on('error', (e) => {
  console.error('连接失败：', e.message, `\n服务端在跑吗？ curl http://localhost:${PORT}/health`);
  process.exit(1);
});
