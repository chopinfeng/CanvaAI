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
 *   npx tsx scripts/seed-exam-set.ts exam-set --clean  # 恢复出厂：连试用痕迹一起清掉
 *   npx tsx scripts/seed-exam-set.ts scan U1 --scan-only  # 只放原图，逼 Agent 真去看图
 *
 * 默认只清自己上次注入的图元，用户自己画的和 AI 的批注都留着——重跑不该毁掉别人的东西。
 * `--clean` 是演示前的"恢复出厂"：房间里的一切都清空，再灌一遍，
 * 并让服务端忘掉这一轮的对话历史、辅导账本和模式。
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

const argv = process.argv.slice(2);
const clean = argv.includes('--clean');
/**
 * 只放扫描件，不放转录文本。
 *
 * 平时两份并排是为了肉眼核对转换对不对。但要验"视觉这条路通不通"，
 * 并排反而没法验：文本就在旁边，Agent 会直接读文本，
 * 压根不会去调 canvas_snapshot——我第一次冒烟测试就栽在这儿，
 * 它答对了矩阵，但全程没发生一次光栅化。
 */
const scanOnly = argv.includes('--scan-only');
const [roomArg, ...only] = argv.filter((a) => !a.startsWith('--'));
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
  shapes.push(text(LEFT_X, top, `${index + 1}. [${p.id}] ${p.topic} · ${p.level}`, 20, ACCENT, 'problem-title'));

  const bodyTop = top + 40;

  /* ---- 左：原图 ---- */
  shapes.push(text(LEFT_X, bodyTop, '原图（模拟扫描件）', 14, MUTED, 'section-label'));
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

  /* ---- 右：转换结果。--scan-only 时整块跳过，只留原图 ---- */
  if (scanOnly) {
    shapes.push({
      type: 'line',
      points: [
        [LEFT_X, leftBottom + CARD_GAP / 2],
        [LEFT_X + IMG_W, leftBottom + CARD_GAP / 2],
      ],
      style: { stroke: '#e7e5e4', strokeWidth: 1 },
      meta: { role: 'divider' },
    });
    return { shapes, height: leftBottom + CARD_GAP - top };
  }

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
    shapes.push(text(RIGHT_X, rightBottom + 18, '矢量化图形（坐标由题给条件算出，已验算）：', 14, MUTED, 'section-label'));
    const origin = { x: RIGHT_X + 120, y: rightBottom + 260 };
    shapes.push(...p.figure(origin));
    rightBottom += 18 + 330;
  } else {
    // 为什么不矢量化，写在画布上——否则看的人只会以为是漏了
    const note = wrap(`未矢量化，以原图为准。原因：${p.figureNote ?? '图形无法由题给条件唯一确定。'}`, RIGHT_W, 13);
    shapes.push(text(RIGHT_X, rightBottom + 18, note, 13, '#a8a29e', 'figure-note'));
    rightBottom += 18 + countLines(note) * 13 * 1.4;
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
  syncProtocol.readSyncMessage(dec, enc, doc, 'remote');
  if (encoding.length(enc) > 0) send(FrameTag.Sync, encoding.toUint8Array(enc));

  if (done) return;

  /**
   * 等同步真正结束再写。
   *
   * 第一条 Sync 是服务端的 step1（来要我们的状态），那时本地文档还是空的——
   * 在那一刻去找"上次注入的图元"一个都找不到，旧内容不会被清掉，
   * 重跑一次就在画布上叠一层（实测叠出 507 个图元）。
   * 改成「不再收到 sync 消息 400ms」才动手。
   */
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    if (done) return;
    done = true;
    void seed();
  }, 400);
});

async function seed(): Promise<void> {
  const all = scene.all();
  const stale = clean ? all : all.filter((s) => s.author.id === 'seed');
  if (stale.length > 0) {
    const mine = stale.filter((s) => s.author.id === 'seed').length;
    scene.delete(stale.map((s) => s.id));
    console.log(
      clean
        ? `恢复出厂：清掉全部 ${stale.length} 个图元（其中上次注入的 ${mine} 个，试用痕迹 ${stale.length - mine} 个）`
        : `清掉上一次注入的 ${stale.length} 个图元`,
    );
  }
  if (clean) {
    // 会话状态（对话历史、辅导账本、模式）只活在服务端内存里，不在文档里。
    // 不说这一声，画布是新的，Agent 却还记得上一场讲过的整道题。
    ws.send(encodeFrame(FrameTag.Control, new TextEncoder().encode(JSON.stringify({ t: 'session.reset' }))));
  }

  let cursor = 80;
  let total = 0;

  for (const [i, p] of picked.entries()) {
    const { shapes, height } = await buildCard(p, cursor, i);
    scene.create(shapes, { author: { id: 'seed', kind: 'user', name: '卷子' }, layer: 'user' });
    console.log(
      `  ${String(i + 1).padStart(2)}. ${p.id.padEnd(4)} ${p.topic.padEnd(20)} ${p.figure ? '含矢量图' : '仅原图  '}  (${shapes.length} 个图元)`,
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
