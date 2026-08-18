/**
 * 把 20 道真题灌进一个房间：每题左边原图、右边转换结果。
 *
 * 左右并排是刻意的——"转换得对不对"必须能肉眼核对，而不是相信转换过程。
 * 所有内容落在 user 图层：这是用户带进来的卷子，AI 只能批注。
 *
 * 用法：
 *   npx tsx scripts/seed-exam-set.ts [roomId] [题号...]
 *   npx tsx scripts/seed-exam-set.ts exam-set          # 全部 20 题
 *   npx tsx scripts/seed-exam-set.ts drill S3 T8       # 只灌指定题
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Scene } from '@canvai/canvas-core';
import type { ShapeInput } from '@canvai/protocol';
import { FrameTag, decodeFrame, encodeFrame } from '@canvai/protocol';
import { PROBLEMS, type Problem } from './problems.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CROPS = join(here, '../../../.work/crops');
const PORT = process.env.PORT ?? '3001';
const BASE = `http://localhost:${PORT}`;

const [, , roomArg, ...only] = process.argv;
const roomId = roomArg ?? 'exam-set';
const picked = only.length > 0 ? PROBLEMS.filter((p) => only.includes(p.id)) : PROBLEMS;

/* ------------------------------------------------------------------ *
 * 排版常量
 * ------------------------------------------------------------------ */

const LEFT_X = 80;          // 原图起点
const IMG_W = 890;          // 原图按原始像素宽放置，1:1 对照最可靠
const RIGHT_X = 1060;       // 转换结果起点
const RIGHT_W = 820;
const CARD_GAP = 90;
const INK = '#1c1917';
const MUTED = '#78716c';
const ACCENT = '#2563eb';

/** PNG 尺寸直接读 IHDR，不必引入图片库 */
function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Konva 的 Text 不会自动折行，这里按字宽估算手动折 */
function wrap(text: string, maxWidth: number, fontSize: number): string {
  const perLine = Math.floor(maxWidth / fontSize);
  return text
    .split('\n')
    .map((para) => {
      const out: string[] = [];
      let cur = '';
      let units = 0;
      for (const ch of para) {
        const w = ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55;
        if (units + w > perLine) {
          out.push(cur);
          cur = '';
          units = 0;
        }
        cur += ch;
        units += w;
      }
      if (cur) out.push(cur);
      return out.join('\n');
    })
    .join('\n');
}

const countLines = (s: string) => s.split('\n').length;

/* ------------------------------------------------------------------ *
 * 上传原图
 * ------------------------------------------------------------------ */

async function uploadCrop(file: string): Promise<{ assetId: string; w: number; h: number }> {
  const bytes = await readFile(join(CROPS, file));
  const res = await fetch(`${BASE}/assets`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) throw new Error(`上传 ${file} 失败：${res.status} ${await res.text()}`);
  const { assetId } = (await res.json()) as { assetId: string };
  return { assetId, ...pngSize(bytes) };
}

/* ------------------------------------------------------------------ *
 * 生成一道题的图元
 * ------------------------------------------------------------------ */

const text = (
  x: number,
  y: number,
  s: string,
  size: number,
  color = INK,
  role = 'text',
): ShapeInput => ({
  type: 'text',
  x,
  y,
  text: s,
  style: { stroke: color, fontSize: size },
  meta: { role },
});

async function buildCard(p: Problem, top: number, index: number): Promise<{ shapes: ShapeInput[]; height: number }> {
  const shapes: ShapeInput[] = [];
  const img = await uploadCrop(p.image);

  /* ---- 标题条 ---- */
  shapes.push(text(LEFT_X, top, `${index + 1}. [${p.id}] ${p.source} · ${p.topic}`, 20, ACCENT, 'problem-title'));

  const bodyTop = top + 40;

  /* ---- 左：原图 ---- */
  shapes.push(text(LEFT_X, bodyTop, '原图（试卷扫描件）', 14, MUTED, 'section-label'));
  shapes.push({
    type: 'image',
    x: LEFT_X,
    y: bodyTop + 24,
    w: IMG_W,
    h: Math.round((img.h * IMG_W) / img.w),
    assetId: img.assetId,
    meta: { role: 'source-image', label: `${p.id} 原图`, problem: p.id },
  });
  const leftBottom = bodyTop + 24 + Math.round((img.h * IMG_W) / img.w);

  /* ---- 右：转换结果 ---- */
  shapes.push(text(RIGHT_X, bodyTop, '转换结果（画板内容）', 14, MUTED, 'section-label'));

  const wrapped = wrap(p.statement, RIGHT_W, 15);
  shapes.push(text(RIGHT_X, bodyTop + 24, wrapped, 15, INK, 'statement'));
  let rightBottom = bodyTop + 24 + countLines(wrapped) * 15 * 1.4;

  if (p.known) {
    const kv = Object.entries(p.known)
      .map(([k, v]) => `${k} = ${v}`)
      .join('　');
    shapes.push(text(RIGHT_X, rightBottom + 14, `已知：${wrap(kv, RIGHT_W, 14)}`, 14, '#059669', 'known'));
    rightBottom += 14 + countLines(wrap(kv, RIGHT_W, 14)) * 14 * 1.4;
  }

  if (p.figure) {
    shapes.push(text(RIGHT_X, rightBottom + 18, '矢量化图形：', 14, MUTED, 'section-label'));
    const origin = { x: RIGHT_X + 90, y: rightBottom + 210 };
    shapes.push(...p.figure(origin));
    rightBottom += 18 + 250;
  } else {
    shapes.push(
      text(RIGHT_X, rightBottom + 18, '（图形较复杂，未矢量化，以原图为准）', 13, '#a8a29e', 'figure-note'),
    );
    rightBottom += 18 + 20;
  }

  const bottom = Math.max(leftBottom, rightBottom);

  /* ---- 分隔线 ---- */
  shapes.push({
    type: 'line',
    points: [
      [LEFT_X, bottom + CARD_GAP / 2],
      [RIGHT_X + RIGHT_W, bottom + CARD_GAP / 2],
    ],
    style: { stroke: '#e7e5e4', strokeWidth: 1 },
    meta: { role: 'divider' },
  });

  return { shapes, height: bottom + CARD_GAP - top };
}

/* ------------------------------------------------------------------ *
 * 连房间写入
 * ------------------------------------------------------------------ */

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
  syncProtocol.readSyncMessage(dec, enc, doc, 'remote');
  if (encoding.length(enc) > 0) send(FrameTag.Sync, encoding.toUint8Array(enc));

  if (done) return;
  done = true;
  void seed();
});

async function seed(): Promise<void> {
  const stale = scene.all().filter((s) => s.author.id === 'seed');
  if (stale.length > 0) {
    scene.delete(stale.map((s) => s.id));
    console.log(`清掉上一次注入的 ${stale.length} 个图元`);
  }

  let cursor = 80;
  let total = 0;

  for (const [i, p] of picked.entries()) {
    const { shapes, height } = await buildCard(p, cursor, i);
    scene.create(shapes, { author: { id: 'seed', kind: 'user', name: '卷子' }, layer: 'user' });
    console.log(
      `  ${String(i + 1).padStart(2)}. ${p.id} ${p.source}  ${p.figure ? '含矢量图' : '仅原图'}  (${shapes.length} 个图元)`,
    );
    cursor += height;
    total += shapes.length;
  }

  console.log(`\n已向房间「${roomId}」注入 ${picked.length} 道题，共 ${total} 个图元，总高 ${Math.round(cursor)}px`);
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 1200);
}

ws.on('error', (e) => {
  console.error('连接失败：', e.message, `\n服务端在跑吗？ curl ${BASE}/health`);
  process.exit(1);
});
