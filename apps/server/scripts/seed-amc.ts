/**
 * 灌一道美国高中数学题（AMC 风格的 13–14–15 三角形），带矢量图。
 *
 * 选多问题目是刻意的：辅导账本是按小问一条条勾掉的，单问题目
 * 走不到"全部讲完才收尾"那条路——而那正是最容易出错、也最该被验的地方。
 * 五问环环相扣（BD→AD→面积→内切圆→外接圆），中间任何一步给错数，
 * 后面全崩——正好检验模型会不会在自己错的前提上理直气壮地往下推。
 *
 * 题面保留英文原文：这是美国卷子本来的样子，而辅导用中文进行。
 * 顺带也验了跨语言这条路——学生读英文题、被中文讲解，是真实场景。
 *
 * 用法：npx tsx scripts/seed-amc.ts [roomId]
 */
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Scene } from '@canvai/canvas-core';
import type { ShapeInput } from '@canvai/protocol';
import { FrameTag, decodeFrame, encodeFrame } from '@canvai/protocol';

const roomId = process.argv[2] ?? 'amc';
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

/* ---- 图：B(0,0) D(5,0) C(14,0) A(5,12)，24px 一个单位 ---- */
const S = 24;
const OX = 620;
const OY = 470;
const P = (ux: number, uy: number): [number, number] => [OX + ux * S, OY - uy * S];
const seg = (a: [number, number], b: [number, number], w = 2, color = INK, role = 'edge'): ShapeInput => ({
  type: 'line',
  points: [a, b],
  style: { stroke: color, strokeWidth: w },
  meta: { role },
});

const A = P(5, 12);
const B = P(0, 0);
const C = P(14, 0);
const D = P(5, 0);

function build(): ShapeInput[] {
  const shapes: ShapeInput[] = [];

  shapes.push(t(80, 80, 'Geometry — Triangle with an Altitude', 20, ACCENT, 'problem-title'));
  shapes.push(t(80, 112, 'AMC-style · 5 parts', 12.5, MUTED, 'section-label'));

  const stmt = [
    'In triangle ABC, AB = 13, BC = 14, and CA = 15.',
    'Let D be the foot of the altitude from A to side BC.',
    '',
    '(1) Find BD and DC.',
    '(2) Find the length of the altitude AD.',
    '(3) Find the area of triangle ABC.',
    '(4) Find the radius r of the inscribed circle.',
    '(5) Find the radius R of the circumscribed circle.',
  ].join('\n');
  shapes.push(t(80, 150, stmt, 15.5, INK, 'statement'));

  shapes.push(
    t(80, 360, 'Show your work for each part.', 13, MUTED, 'hint'),
  );

  /* ---- 图形：AI 要能指着它讲，所以每条边单独一个图元 ---- */
  shapes.push(seg(B, C, 2, INK, 'side-BC'));
  shapes.push(seg(B, A, 2, INK, 'side-AB'));
  shapes.push(seg(C, A, 2, INK, 'side-CA'));
  // 高用虚线的替代：细一点、灰一点，和三条边区分开
  shapes.push(seg(A, D, 1.5, '#dc2626', 'altitude-AD'));

  // 直角标记
  const m = 10;
  shapes.push(seg([D[0], D[1] - m], [D[0] + m, D[1] - m], 1.2, '#dc2626', 'right-angle'));
  shapes.push(seg([D[0] + m, D[1] - m], [D[0] + m, D[1]], 1.2, '#dc2626', 'right-angle'));

  shapes.push(t(A[0] - 8, A[1] - 26, 'A', 15, INK, 'vertex'));
  shapes.push(t(B[0] - 20, B[1] + 6, 'B', 15, INK, 'vertex'));
  shapes.push(t(C[0] + 8, C[1] + 6, 'C', 15, INK, 'vertex'));
  shapes.push(t(D[0] - 6, D[1] + 10, 'D', 15, '#dc2626', 'vertex'));

  // 边长标注：只标题目给的三条，BD/DC/AD 是要求的，不能先写出来
  shapes.push(t((A[0] + B[0]) / 2 - 34, (A[1] + B[1]) / 2 - 8, '13', 14, MUTED, 'edge-label'));
  shapes.push(t((A[0] + C[0]) / 2 + 14, (A[1] + C[1]) / 2 - 8, '15', 14, MUTED, 'edge-label'));
  shapes.push(t((B[0] + C[0]) / 2 - 8, B[1] + 14, '14', 14, MUTED, 'edge-label'));

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

ws.on('open', () => {
  const enc = encoding.createEncoder();
  syncProtocol.writeSyncStep1(enc, doc);
  send(FrameTag.Sync, encoding.toUint8Array(enc));
});

ws.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
  const { tag, payload } = decodeFrame(bytes);
  if (tag !== FrameTag.Sync) return;
  const dec = decoding.createDecoder(payload);
  const enc = encoding.createEncoder();
  /**
   * readSyncMessage 会把消息类型返回出来。0 是 step1（服务端来要我们的状态），
   * 1 是 step2、2 是 update——后两者才代表"服务端把它有的东西给我们了"。
   *
   * 这个区分是必需的。只等"400ms 没新消息"的话，服务端刚启动、房间还在
   * 从磁盘加载时，我们收到的只有一条 step1，然后就安静了——于是在**空文档**上
   * 执行清理（删了个寂寞），写完新的一份，等服务端的真实状态到达时 CRDT 一合，
   * 画布上就是两份题。实测在房间 amc 上撞出过 34 个图元（应该是 17）。
   */
  const kind = syncProtocol.readSyncMessage(dec, enc, doc, 'remote');
  if (kind !== syncProtocol.messageYjsSyncStep1) gotServerState = true;
  if (encoding.length(enc) > 0) send(FrameTag.Sync, encoding.toUint8Array(enc));
  if (done) return;

  // 等同步真的结束再写，否则会在空文档上"清理"，然后叠一层
  if (!gotServerState) return; // 服务端还没把它有的东西给我们，现在动手就是在空文档上动手
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    if (done) return;
    done = true;

    const all = scene.all();
    if (all.length > 0) {
      scene.delete(all.map((s) => s.id));
      console.log(`清掉旧的 ${all.length} 个图元`);
    }
    // 会话状态在服务端内存里，不在文档里——不重置的话画布是新的但 Agent 还记得上一场
    ws.send(encodeFrame(FrameTag.Control, new TextEncoder().encode(JSON.stringify({ t: 'session.reset' }))));

    const shapes = build();
    scene.create(shapes, { author: { id: 'seed', kind: 'user', name: '卷子' }, layer: 'user' });
    console.log(`已向房间「${roomId}」注入 1 道题（5 问），${shapes.length} 个图元`);
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
