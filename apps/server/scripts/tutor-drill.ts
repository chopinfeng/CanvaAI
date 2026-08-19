/**
 * 辅导演练：让「学生 Agent」以普通用户的身份进房间，走完一整场辅导，然后判分。
 *
 * 为什么要有这个：辅导是一条来回十几轮才走得完的路。靠人肉当学生走一遍，
 * 一次十来分钟，而且只覆盖得到自己想得起来的那几种反应——真正会出问题的
 * 「答错之后绕不出来」「中途说不学了」「第(2)问被跳过」反而测不到。
 * 把学生也做成 Agent，这件事就变成可重复的。
 *
 * 它是**真的在做题**：连的是同一个 WebSocket、同一套协议、同一块 Yjs 文档，
 * 老师那边完全不知道对面是个程序。所以跑通了就是真的跑通了。
 *
 * 用法：
 *   npx tsx scripts/tutor-drill.ts                      # 默认人设 careless
 *   npx tsx scripts/tutor-drill.ts --persona struggling
 *   npx tsx scripts/tutor-drill.ts --room drill7 --persona impatient --max-turns 30
 *   npx tsx scripts/tutor-drill.ts --request "第(2)问我不会，带我做一下"
 */
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Scene, unionBounds, shapeBounds } from '@canvai/canvas-core';
import type { ClientMessage, Rect, ServerMessage, ShapeInput } from '@canvai/protocol';
import { FrameTag, decodeFrame, encodeFrame } from '@canvai/protocol';
import { DeepSeekClient, PERSONAS, StudentAgent, describeForStudent } from '@canvai/agent';
import type { PersonaName, StudentPort } from '@canvai/agent';
import { config, hasAgent } from '../src/config.ts';

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const roomId = flag('room', `drill-${Date.now().toString(36)}`)!;
const personaName = (flag('persona', 'careless') as PersonaName)!;
const request = flag('request', '给我讲这道题')!;
const maxTurns = Number(flag('max-turns', '24'));
const PORT = process.env.PORT ?? '3001';

if (!(personaName in PERSONAS)) {
  console.error(`没有「${personaName}」这个人设。可选：${Object.keys(PERSONAS).join(' / ')}`);
  process.exit(1);
}
if (!hasAgent()) {
  console.error('没配 DEEPSEEK_API_KEY，老师和学生都跑不起来。');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 以普通客户端的身份连进房间
 * ------------------------------------------------------------------ */

const doc = new Y.Doc();
const scene = new Scene(doc);
const uid = 'u_student';
const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${roomId}&uid=${uid}&name=%E5%AD%A6%E7%94%9F`);
ws.binaryType = 'arraybuffer';

const sendFrame = (tag: number, payload: Uint8Array) => ws.send(encodeFrame(tag as 0 | 1 | 2 | 3, payload));
const sendControl = (msg: ClientMessage) =>
  sendFrame(FrameTag.Control, new TextEncoder().encode(JSON.stringify(msg)));

doc.on('update', (update: Uint8Array, origin: unknown) => {
  if (origin === 'remote') return;
  const enc = encoding.createEncoder();
  syncProtocol.writeUpdate(enc, update);
  sendFrame(FrameTag.Sync, encoding.toUint8Array(enc));
});

/* ------------------------------------------------------------------ *
 * 转录 + 判分
 * ------------------------------------------------------------------ */

interface Transcript {
  asks: string[];
  judges: Array<{ verdict: string; comment: string }>;
  answers: string[];
  says: string[];
  /** 老师说过的话，用来核对停手时有没有交代清楚 */
  teacherSays: string[];
  /** 收尾时 tutor_finish 会把清单清空，所以留一份最后一次非空的快照 */
  todos: Array<{ text: string; done: boolean }>;
  everPlanned: boolean;
  modes: Array<{ mode: string; note?: string }>;
  toolErrors: Array<{ name: string; error: string }>;
  /** 被辅导机制主动拦下的调用——是好事，单独计 */
  guardHits: Array<{ name: string; error: string }>;
  drew: number;
  /** 老师这一轮在图上指过东西没有（highlight/spotlight/zoom/create） */
  pointedBeforeAsk: boolean[];
}

const tape: Transcript = {
  asks: [],
  judges: [],
  answers: [],
  says: [],
  teacherSays: [],
  todos: [],
  everPlanned: false,
  modes: [],
  toolErrors: [],
  guardHits: [],
  drew: 0,
  pointedBeforeAsk: [],
};

const POINTING = new Set(['canvas_highlight', 'canvas_spotlight', 'canvas_zoom_to', 'canvas_create', 'canvas_ink']);
let pointedSinceAsk = false;

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (who: string, text: string) => console.log(`[${stamp()}] ${who} ${text}`);

/* ------------------------------------------------------------------ *
 * 学生的手脚
 * ------------------------------------------------------------------ */

const port: StudentPort = {
  say(text) {
    tape.says.push(text);
    log('学生 →', text);
    sendControl({ t: 'user.text', text });
  },
  answer(askId, text) {
    tape.answers.push(text);
    log('学生 →', text);
    sendControl({ t: 'agent.answer', askId, answer: text });
  },
  draw(shapes: ShapeInput[], note) {
    const { ids } = scene.create(shapes, {
      author: { id: uid, kind: 'user', name: '学生' },
      layer: 'user',
    });
    const region = unionBounds(ids.map((id) => shapeBounds(scene.get(id)!)));
    tape.drew += ids.length;
    log('学生 ✎', `画了 ${ids.length} 个图元${note ? `（${note}）` : ''}`);
    sendControl({ t: 'user.draw', shapeIds: ids, region });
    return { ids, region };
  },
  look(region?: Rect) {
    return describeForStudent(scene, region);
  },
};

const student = new StudentAgent({
  model: new DeepSeekClient({
    apiKey: config.deepseek.apiKey,
    baseUrl: config.deepseek.baseUrl,
    model: config.deepseek.model,
  }),
  port,
  persona: PERSONAS[personaName],
  // 学生的每一步都打出来。少了这个，"它看了一眼画布然后没下文"在日志里
  // 长得和"它压根没动"一模一样——第一次跑演练就栽在这上面。
  onStep: ({ tool, result }) => {
    if (tool === 'student_look') log('学生 👀', '看了一眼画布');
    else if (tool === 'student_done') log('学生 ·', '（等老师）');
    else if (tool !== 'student_say' && tool !== 'student_answer' && tool !== 'student_draw') {
      log('学生 ?', `${tool} → ${result ?? ''}`);
    }
  },
});

/* ------------------------------------------------------------------ *
 * 主循环：老师问 → 学生动 → 老师问…
 * ------------------------------------------------------------------ */

let turns = 0;
let finished = false;
/** 学生正在想，别让新消息叠着触发第二次 */
let thinking = false;
let idleTimer: NodeJS.Timeout | null = null;

async function nudgeStudent(): Promise<void> {
  if (thinking || finished) return;
  if (turns >= maxTurns) {
    log('演练', `到了 ${maxTurns} 轮上限，停。`);
    return finish();
  }
  thinking = true;
  turns++;
  try {
    await student.act();
  } catch (e) {
    log('演练', `学生这边出错：${(e as Error).message}`);
  } finally {
    thinking = false;
  }
}

/** 老师那边安静下来之后，再推学生动一步——避免半句话就抢答 */
function scheduleNudge(ms = 1200): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void nudgeStudent(), ms);
  armQuiet();
}

/**
 * 两边都不说话了就收工。
 *
 * 没有这个，"学生要了答案、老师给了、然后大家都没话了"这种正常结局
 * 会一直干等到 10 分钟的总超时——第一次跑 impatient 就是这么卡住的。
 */
let quietTimer: NodeJS.Timeout | null = null;
function armQuiet(ms = 45_000): void {
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    if (finished) return;
    log('演练', '两边都没动静了，收工。');
    finish();
  }, ms);
}

ws.on('open', () => {
  const enc = encoding.createEncoder();
  syncProtocol.writeSyncStep1(enc, doc);
  sendFrame(FrameTag.Sync, encoding.toUint8Array(enc));
});

let started = false;
let settle: NodeJS.Timeout | null = null;

ws.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
  const { tag, payload } = decodeFrame(bytes);

  if (tag === FrameTag.Sync || tag === FrameTag.SyncAI) {
    const dec = decoding.createDecoder(payload);
    const enc = encoding.createEncoder();
    syncProtocol.readSyncMessage(dec, enc, doc, 'remote');
    if (encoding.length(enc) > 0) sendFrame(FrameTag.Sync, encoding.toUint8Array(enc));

    // 同步完成再开口：文档还空着的时候看画布只会看到一片空白
    if (!started) {
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        if (started) return;
        started = true;
        void openSession();
      }, 500);
    }
    return;
  }

  if (tag !== FrameTag.Control) return;
  const msg = JSON.parse(new TextDecoder().decode(payload)) as ServerMessage;
  handleServer(msg);
});

function handleServer(msg: ServerMessage): void {
  switch (msg.t) {
    case 'agent.say':
      tape.teacherSays.push(msg.text);
      log('老师 ←', msg.text);
      break;
    case 'agent.judge':
      tape.judges.push({ verdict: msg.verdict, comment: msg.comment });
      log('老师 ←', `[${msg.verdict}] ${msg.comment}`);
      break;
    case 'agent.ask':
      tape.asks.push(msg.question);
      tape.pointedBeforeAsk.push(pointedSinceAsk);
      pointedSinceAsk = false;
      log('老师 ?', msg.question);
      break;
    case 'agent.todo':
      // 清单被清空是收尾的正常动作，别把它当成"从来没拆过题"
      if (msg.items.length > 0) {
        tape.todos = msg.items;
        tape.everPlanned = true;
      }
      break;
    case 'session.mode':
      tape.modes.push({ mode: msg.mode, ...(msg.note ? { note: msg.note } : {}) });
      log('演练', `模式 → ${msg.mode}${msg.note ? ` ${msg.note}` : ''}`);
      // 辅导结束（讲完了或者学生自己要走）就收工
      if (msg.mode === 'assist' && started) setTimeout(finish, 2500);
      break;
    case 'agent.tool':
      if (msg.call.state === 'error') {
        const err = msg.call.error ?? '';
        // 被辅导那几道闸拦下来不算故障，那正是它们该干的事——
        // 混在一起数，真正的工具失败就被淹掉了
        const guarded =
          /还没说这答案对不对|还没给判定|还没拆过题|还有 \d+ 个小问没解决|辅导已经结束了|没有待判定的回答/.test(
            err,
          );
        (guarded ? tape.guardHits : tape.toolErrors).push({ name: msg.call.name, error: err });
      }
      if (msg.call.state === 'ok' && POINTING.has(msg.call.name)) pointedSinceAsk = true;
      break;
    case 'agent.turn.end':
      // 老师这一轮说完了，轮到学生
      scheduleNudge();
      break;
    default:
      break;
  }

  student.observe(msg);
  if (msg.t === 'agent.ask') scheduleNudge(600);
}

async function openSession(): Promise<void> {
  console.log(`\n=== 辅导演练 · 房间 ${roomId} · 人设 ${personaName} ===\n`);
  log('演练', `画布上有 ${scene.size} 个图元`);
  thinking = true;
  try {
    await student.open(request);
  } finally {
    thinking = false;
    // 开场这条路上没有 turn.end 可以挂，静默计时得在这儿起
    armQuiet();
  }
}

/* ------------------------------------------------------------------ *
 * 判分
 * ------------------------------------------------------------------ */

function finish(): void {
  if (finished) return;
  finished = true;
  if (idleTimer) clearTimeout(idleTimer);

  /**
   * soft 的那几项是"讲得好不好"，不是"跑没跑通"。
   * 混在一起算，一个风格指标就能把整场演练判成失败，反而看不出真出了什么事。
   */
  const checks: Array<{ ok: boolean; name: string; detail: string; soft?: boolean }> = [];
  const add = (ok: boolean, name: string, detail: string, soft = false) =>
    checks.push({ ok, name, detail, soft });

  const entered = tape.modes.some((m) => m.mode === 'tutor');
  /** 学生自己把辅导喊停了（要答案 / 去做别的） */
  const wantedOut = tape.says.some((s) => /不学了|直接告诉我|直接给|要答案|别问了/.test(s));

  /**
   * 先认清这一局是什么局面，再决定拿哪把尺子量。
   *
   * 学生一上来就说"直接告诉我答案"，老师照办、没有强行反问——
   * 那是对的行为，不该按"没进辅导模式"记一笔失败。
   */
  if (!entered && wantedOut) {
    console.log('\n（这一局学生开口就要答案，按"该直接答"来判，不按辅导流程判）');
    add(tape.says.length > 0, '学生开了口', `说了 ${tape.says.length} 句`);
    add(tape.asks.length === 0, '没有强行反问', tape.asks.length === 0 ? '照他要求直接答了' : `还是问了 ${tape.asks.length} 次`);
    add(tape.toolErrors.length === 0, '工具没真出错', tape.toolErrors.length === 0 ? '一次都没有' : tape.toolErrors.map((e) => `${e.name}: ${e.error}`).join('；'));
    return report(checks);
  }

  add(entered, '一句话进入辅导', entered ? '识别到求讲解，自动切了模式' : '始终没进辅导模式');

  add(tape.everPlanned, '拆过题', tape.everPlanned ? `${tape.todos.length} 个小问` : '从来没拆过题');

  const undone = tape.todos.filter((i) => !i.done);
  add(
    undone.length === 0 || wantedOut,
    '每一问都解决了',
    undone.length === 0
      ? '清单全部打勾'
      : `还剩 ${undone.length} 个，但学生自己要走的（合理）：${undone.map((i) => i.text).join('；')}`,
  );

  add(
    tape.judges.length >= tape.answers.length,
    '每次回答都有判定',
    `回答 ${tape.answers.length} 次，判定 ${tape.judges.length} 次`,
  );

  const ended = tape.modes.at(-1);
  const paused = tape.says.length >= 0 && tapeSaidPause();
  add(
    (!!ended && ended.mode === 'assist' && !!ended.note) || paused,
    '结束时说清楚了',
    ended?.mode === 'assist' && ended.note ? ended.note : paused ? '中途停下时说清了停在哪一问' : '结束时没有明确说明',
  );

  const anchored = tape.pointedBeforeAsk.filter(Boolean).length;
  add(
    tape.asks.length === 0 || anchored / tape.asks.length >= 0.6,
    '提问前指了图',
    `${tape.asks.length} 个问题里有 ${anchored} 个提问前在图上标过`,
    true,
  );

  add(
    tape.toolErrors.length === 0,
    '工具没真出错',
    tape.toolErrors.length === 0
      ? '一次都没有'
      : tape.toolErrors.map((e) => `${e.name}: ${e.error}`).join('；'),
  );

  if (tape.guardHits.length > 0) {
    console.log(
      `\n（辅导机制拦下 ${tape.guardHits.length} 次，都是该拦的：` +
        `${tape.guardHits.map((g) => g.name).join('、')}）`,
    );
  }

  report(checks);
}

/** 主循环兜底那句"这次辅导先停在这里…"也算说清楚了 */
function tapeSaidPause(): boolean {
  return tape.teacherSays.some((t) => t.includes('先停在这里'));
}

function report(checks: Array<{ ok: boolean; name: string; detail: string; soft?: boolean }>): void {
  console.log('\n=== 判分 ===');
  for (const c of checks) {
    const mark = c.ok ? '✓' : c.soft ? '⚠' : '✗';
    console.log(`${mark} ${c.name.padEnd(14)} ${c.detail}`);
  }
  console.log(
    `\n共 ${turns} 轮 · 老师问了 ${tape.asks.length} 次 · 学生答了 ${tape.answers.length} 次 · 学生画了 ${tape.drew} 个图元`,
  );

  const failed = checks.filter((c) => !c.ok && !c.soft);
  const soft = checks.filter((c) => !c.ok && c.soft);
  console.log(
    failed.length === 0
      ? `\n辅导全过程跑通。${soft.length > 0 ? `（${soft.length} 项讲解质量还能再好：${soft.map((c) => c.name).join('、')}）` : ''}\n`
      : `\n有 ${failed.length} 项没过。\n`,
  );

  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

ws.on('error', (e) => {
  console.error('连接失败：', e.message, `\n服务端在跑吗？ curl localhost:${PORT}/health`);
  process.exit(1);
});

// 整体兜底：别让一次跑飞的演练挂在那儿
setTimeout(() => {
  log('演练', '超时（10 分钟），强制收尾。');
  finish();
}, 10 * 60_000);
