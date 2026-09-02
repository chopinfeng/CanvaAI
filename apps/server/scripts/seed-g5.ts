/**
 * 灌 G5（等边三角形全等题）进一个房间，用于复现 diagramBlockCount 逃生阀
 * + 最终答案漏写 canvas 的调查。模式照抄 seed-amc.ts 的 gotServerState 同步闸。
 *
 * 临时调查脚本，不是长期维护的 seed-*.ts 之一——用完可删。
 *
 * 用法：npx tsx scripts/seed-g5.ts [roomId]
 */
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Scene } from '@canvai/canvas-core';
import type { ShapeInput } from '@canvai/protocol';
import { FrameTag, decodeFrame, encodeFrame } from '@canvai/protocol';
import { G5_FIG } from './figures.ts';
import { buildFigure } from './figure.ts';

const roomId = process.argv[2] ?? 'drill-g5-repro';
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
  shapes.push(t(80, 80, '等边三角形 · 全等', 20, ACCENT, 'problem-title'));
  shapes.push(t(80, 112, '几何 · 较难 · 3 问', 12.5, MUTED, 'section-label'));

  const stmt = [
    '等边△ABC 的边长为 8。点 E 在边 AC 上，点 D 在边 BC 上，且 AE=CD=3，AD 与 BE 交于点 F。',
    '',
    '(1) 求证：AD=BE；',
    '(2) 求 AD 的长；',
    '(3) 求∠BFD 的度数。',
  ].join('\n');
  shapes.push(t(80, 150, stmt, 15.5, INK, 'statement'));

  // 图形放在题干下方——origin 大致对齐 seed-amc.ts 的图形区域
  const fig = buildFigure(G5_FIG, { x: 650, y: 470 });
  shapes.push(...fig);

  return shapes;
}

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
      console.error(`重发了 ${tries - 1} 次握手也没收到房间「${roomId}」的状态。服务端在跑吗？`);
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
    console.log(`已向房间「${roomId}」注入 G5（3 问），${shapes.length} 个图元`);
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 1200);
  }, 400);
});

ws.on('error', (e) => {
  console.error('连接失败：', e.message);
  process.exit(1);
});
