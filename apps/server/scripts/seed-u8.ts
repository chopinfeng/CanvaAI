/**
 * 灌一道本科题：条件极值，拉格朗日乘数法。
 *
 * 比 AMC 那道三角形更复杂：AMC 是纯几何、公式套用，这道题要学生自己
 * 建一个函数（拉格朗日函数 L），再解一个驻点方程组，最后还要说出
 * 代数结果背后的几何意义（"最小值是原点到直线的距离的平方"）——
 * 三问难度依次上一个台阶，最后一问没有标准公式可套，考的是理解。
 *
 * 题面刻意不带图：这道题原则上"不依赖图形"（数字答案不需要画图也能算），
 * 但正是这种题最考验"图文并茂"这条提示词有没有真的落地——
 * 圆 x²+y²=r² 和直线 x+2y=5 相切的那张图，得是 AI 自己想到要画的，
 * 不是照着卷子上现成的图描一遍。AMC 那道题图是卷子给的，AI 只需要
 * 指着讲；这道题图得是 AI 自己画出来的，是更高的一道坎。
 *
 * 用法：npx tsx scripts/seed-u8.ts [roomId]
 */
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Scene } from '@canvai/canvas-core';
import type { ShapeInput } from '@canvai/protocol';
import { FrameTag, decodeFrame, encodeFrame } from '@canvai/protocol';

const roomId = process.argv[2] ?? 'u8';
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

  shapes.push(t(80, 80, '多元微积分 — 条件极值（拉格朗日乘数法）', 20, ACCENT, 'problem-title'));
  shapes.push(t(80, 112, '本科 · 中等偏难 · 3 问', 12.5, MUTED, 'section-label'));

  const stmt = [
    '求函数 f(x, y) = x² + y² 在约束条件 x + 2y = 5 下的最小值。',
    '',
    '(1) 写出拉格朗日函数 L(x, y, λ)；',
    '(2) 由驻点条件（∂L/∂x = 0, ∂L/∂y = 0, ∂L/∂λ = 0）求出 x、y；',
    '(3) 求最小值，并说明它的几何意义。',
  ].join('\n');
  shapes.push(t(80, 150, stmt, 15.5, INK, 'statement'));

  shapes.push(t(80, 320, '每一问都要写出过程，第 (3) 问不能只给数字。', 13, MUTED, 'hint'));

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
    scene.create(shapes, { author: { id: 'seed', kind: 'user', name: '卷子' }, layer: 'user' });
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
