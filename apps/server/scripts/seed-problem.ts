/**
 * 把一道题（题干 + 图形 + 学生作答）注入某个房间的画布。
 *
 * 题目为自编。作答里埋了一个典型错误——把直角三角形的斜边认错，
 * 用来演示辅导模式如何引导学生自己发现问题。
 *
 * 全部落在 user 图层——它相当于"用户带进来的卷子"，AI 只能批注、不能改动，
 * 正好走通图层权限那条设计。
 *
 * 用法：
 *   npx tsx scripts/seed-problem.ts [roomId]
 *   npx tsx scripts/seed-problem.ts [roomId] --blank   # 只要题目和图，不要那份作答
 *   npx tsx scripts/seed-problem.ts [roomId] --clean   # 恢复出厂：连试用痕迹一起清掉
 *
 * 默认只清自己上次注入的图元——重跑不该毁掉用户画的和 AI 批的东西。
 * `--clean` 是演示前的"恢复出厂"：房间里的一切都清空，再灌一遍，
 * 并让服务端忘掉这一轮的对话历史、辅导账本和模式。
 */
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Scene } from '@canvai/canvas-core';
import type { ShapeInput } from '@canvai/protocol';
import { FrameTag, decodeFrame, encodeFrame } from '@canvai/protocol';

const argv = process.argv.slice(2);
const clean = argv.includes('--clean');
/** 只要"原始题目"那一页：题干 + 图形，不含预置的学生作答 */
const blank = argv.includes('--blank');
const roomId = argv.find((a) => !a.startsWith('--')) ?? 'exam';
const PORT = process.env.PORT ?? '3001';

/* ------------------------------------------------------------------ *
 * 坐标映射：数学坐标 (0,0)-(5,3) → 画布像素
 * ------------------------------------------------------------------ */

const UNIT = 34;
const OX = 220;
const OY = 560; // 数学 y=0 对应的画布 y（画布 y 向下）

const px = (x: number, y: number): [number, number] => [OX + x * UNIT, OY - y * UNIT];

/** A(0,0) B(13,0) C(13,5) D(0,5)；AF=13 且 F 在 CD 上 ⇒ DF=12 ⇒ F(12,5)；EF=EB ⇒ BE=13/5 */
const A = px(0, 0);
const B = px(13, 0);
const C = px(13, 5);
const D = px(0, 5);
const F = px(12, 5);
const E = px(13, 13 / 5);

const INK = '#1c1917';
const FOLD = '#2563eb';
const RED = '#dc2626';

const label = (text: string, at: [number, number], size = 15, color = INK): ShapeInput => ({
  type: 'text',
  x: at[0],
  y: at[1],
  text,
  style: { stroke: color, fontSize: size },
  meta: { role: 'label' },
});

const seg = (p: [number, number], q: [number, number], color: string, width = 2, dash?: number[]): ShapeInput => ({
  type: 'line',
  points: [p, q],
  style: { stroke: color, strokeWidth: width, ...(dash ? { dash } : {}) },
  meta: { role: 'figure' },
});

const problem: ShapeInput[] = [
  /* ---- 题干（自编）---- */
  label(
    '矩形 ABCD 中，AB = 13，AD = 5，点 E 在边 BC 上，\n' +
      '将矩形沿直线 AE 翻折，点 B 落在点 F 处，且 F 恰好落在边 CD 上。\n' +
      '（1）求 DF 与 FC 的长；\n' +
      '（2）求线段 BE 的长。',
    [180, 120],
    17,
  ),

  /* ---- 图形：矩形 ABCD ---- */
  {
    type: 'rect',
    x: D[0],
    y: D[1],
    w: 13 * UNIT,
    h: 5 * UNIT,
    style: { stroke: INK, strokeWidth: 2 },
    meta: { role: 'rectangle-ABCD' },
  },

  /* ---- 折痕与折后图形 ---- */
  seg(A, E, FOLD, 2.5),           // 折痕 AE
  seg(A, F, FOLD, 2, [6, 4]),     // 折后 AF
  seg(E, F, FOLD, 2, [6, 4]),     // 折后 EF

  /* ---- 顶点标注 ---- */
  label('A', [A[0] - 22, A[1] + 4]),
  label('B', [B[0] + 8, B[1] + 4]),
  label('C', [C[0] + 8, C[1] - 22]),
  label('D', [D[0] - 22, D[1] - 22]),
  label('E', [E[0] + 8, E[1] - 10]),
  label('F', [F[0] - 6, F[1] - 26]),

  /* ---- 已知量 ---- */
  label('13', [(A[0] + B[0]) / 2 - 8, A[1] + 8], 14),
  label('5', [D[0] - 20, (D[1] + A[1]) / 2 - 10], 14),

  /* ---- C 处的直角标记 ---- */
  {
    type: 'polygon',
    points: [
      [C[0] - 14, C[1]],
      [C[0] - 14, C[1] + 14],
      [C[0], C[1] + 14],
    ],
    style: { stroke: INK, strokeWidth: 1.5 },
    meta: { role: 'right-angle-mark' },
  },

];

/**
 * 学生作答（含一个典型错误）。
 *
 * 前面全对，最后一步把 Rt△ECF 的斜边认错了：直角在 C，
 * 斜边应是 EF（=EB=x），而作答把 EC 当成了斜边。
 *   正确：x² = (5−x)² + 1²  ⇒ 10x = 26 ⇒ x = 13/5
 *   错解：(5−x)² = x² + 1²  ⇒ 10x = 24 ⇒ x = 12/5
 * 两个答案长得都像对的，正适合演示"引导学生自己发现错在哪"。
 *
 * 想从一张白纸开始讲（而不是批一份现成的错解）就加 `--blank`。
 */
const studentWork: ShapeInput[] = [
  label('【学生作答】', [980, 150], 17, RED),
  label(
    '解：由折叠得 AF = AB = 13\n' +
      '在 Rt△ADF 中，\n' +
      '  DF = √(13² − 5²) = 12\n' +
      '∴ FC = DC − DF = 13 − 12 = 1\n' +
      '\n' +
      '设 BE = x，则 EC = 5 − x\n' +
      '在 Rt△ECF 中，∠C = 90°\n' +
      '\n' +
      '  EC² = EF² + FC²\n' +
      '  (5 − x)² = x² + 1²\n' +
      '  25 − 10x + x² = x² + 1\n' +
      '  10x = 24\n' +
      '  x = 12/5\n' +
      '\n' +
      '答：BE = 12/5',
    [980, 190],
    15,
  ),
  {
    type: 'text',
    x: 980,
    y: 496,
    text: '✗  −4 分',
    style: { stroke: RED, fontSize: 18 },
    meta: { role: 'grading-mark' },
  },
];

const shapes: ShapeInput[] = blank ? problem : [...problem, ...studentWork];

/* ------------------------------------------------------------------ *
 * 连上房间，写入，等同步完成
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

let seeded = false;
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

  if (seeded) return;
  // 同 seed-exam-set：首条 Sync 是 step1，此时文档还空着，
  // 立刻去查"上次注入的图元"会查不到，重跑就会叠一层
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    if (seeded) return;
    seeded = true;
    doSeed();
  }, 400);
});

function doSeed(): void {
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
    send(FrameTag.Control, new TextEncoder().encode(JSON.stringify({ t: 'session.reset' })));
  }

  const { ids } = scene.create(shapes, {
    author: { id: 'seed', kind: 'user', name: '卷子' },
    layer: 'user',
  });

  console.log(
    `已向房间「${roomId}」注入 ${ids.length} 个图元（user 图层）` +
      (blank ? '——只有题目和图，没有那份学生作答' : ''),
  );
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 800);
}

ws.on('error', (e) => {
  console.error('连接失败：', e.message, '\n服务端在跑吗？ curl localhost:' + PORT + '/health');
  process.exit(1);
});
