/**
 * 连进房间，等 Yjs 真同步完，把画布渲染成 PNG。
 *
 * 临时调查脚本，用完可删。
 *
 * 用法：npx tsx scripts/board-shot.ts <roomId> <outPng>
 */
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Scene, sceneToSvg } from '@canvai/canvas-core';
import { FrameTag, decodeFrame, encodeFrame } from '@canvai/protocol';

const roomId = process.argv[2];
const outPng = process.argv[3] ?? `/tmp/board-${roomId}.png`;
if (!roomId) {
  console.error('用法：npx tsx scripts/board-shot.ts <roomId> <outPng>');
  process.exit(1);
}
const PORT = process.env.PORT ?? '3001';

const doc = new Y.Doc();
const scene = new Scene(doc);
const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${roomId}&uid=shot&name=%E6%88%AA%E5%9B%BE`);
ws.binaryType = 'arraybuffer';
const send = (tag: number, payload: Uint8Array) => ws.send(encodeFrame(tag as 0 | 1 | 2 | 3, payload));

function askForState(): void {
  const enc = encoding.createEncoder();
  syncProtocol.writeSyncStep1(enc, doc);
  send(FrameTag.Sync, encoding.toUint8Array(enc));
}

let gotServerState = false;
ws.on('open', () => askForState());

ws.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
  const { tag, payload } = decodeFrame(bytes);
  if (tag !== FrameTag.Sync) return;
  const dec = decoding.createDecoder(payload);
  const enc = encoding.createEncoder();
  const kind = syncProtocol.readSyncMessage(dec, enc, doc, 'remote');
  if (kind !== syncProtocol.messageYjsSyncStep1) gotServerState = true;
  if (encoding.length(enc) > 0) send(FrameTag.Sync, encoding.toUint8Array(enc));
});

setTimeout(async () => {
  if (!gotServerState) {
    console.error('没等到房间状态，退出');
    process.exit(1);
  }
  const shapes = scene.all();
  console.log(`房间「${roomId}」共 ${shapes.length} 个图元`);
  const svg = sceneToSvg(shapes, { padding: 40 });

  const worker = spawn('node', ['src/render-worker.mjs']);
  const out: Buffer[] = [];
  worker.stdout.on('data', (c) => out.push(c));
  worker.stderr.on('data', (c) => process.stderr.write(c));
  worker.on('close', (code) => {
    if (code !== 0) {
      console.error(`render-worker 退出码 ${code}`);
      process.exit(1);
    }
    writeFileSync(outPng, Buffer.concat(out));
    console.log(`已写入 ${outPng}`);
    ws.close();
    process.exit(0);
  });
  worker.stdin.write(JSON.stringify({ svg, scale: 2 }));
  worker.stdin.end();
}, 6000);
