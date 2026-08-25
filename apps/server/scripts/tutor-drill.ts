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
  /**
   * 服务端喊出来的错（模型调用失败、空转回合……）。
   *
   * 早先这里压根没有分支：服务端 emit 了 {t:'error'}，演练脚本一声不吭地丢掉，
   * 然后判分表上写着"工具没真出错 ✓"。老师中途因为模型报错停了，
   * 而这份表看起来像是产品自己不想讲了。
   */
  serverErrors: Array<{ message: string; detail?: string }>;
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
  serverErrors: [],
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
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
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

/**
 * 学生这一步一句话都没说出去，还剩几次外层重推的机会。
 *
 * student.act() 自己内部已经有一次"你怎么不说话"的自救（见 student.ts），
 * 但那次也失败的话，它就安静地返回了——调用方原来根本没看返回值，
 * 于是老师的问题就那么一直挂着，没人再推一把，直到最外层的静默兜底
 * 把整场演练判死。真机复现过两次：一次是老师主动停下之后学生没接话，
 * 一次是老师刚问完第一句学生就没了下文——两次都不是"学生真答不上来"，
 * 就是没人再戳它一下。这里给它几次真正的重试机会，而不是一次就放弃。
 */
let silentRetries = 0;
const MAX_SILENT_RETRIES = 3;

async function nudgeStudent(): Promise<void> {
  if (thinking || finished) return;
  if (turns >= maxTurns) {
    log('演练', `到了 ${maxTurns} 轮上限，停。`);
    return void finish();
  }
  thinking = true;
  turns++;
  try {
    const result = await student.act();
    /**
     * 不能拿 result.done 当"真的说完了"的证据。
     *
     * 这是个真 bug：student_done 的语义是"这一轮我交球了"，不是"这轮我
     * 答上来了"——看了眼画布、没答上来，也会调 student_done（student.ts
     * 自己内部的静默判断就只看 said/answered，压根不管 done）。
     * 加上 `&& !result.done` 之后，学生内部那次自救也失败、看了眼画布
     * 就交球的情况，被这里误判成"正常结束"，外层重推整个失效——
     * 真机复现过：老师刚问完第一句，学生一次都没真正重推就那么等到
     * 静默超时，跟这条修复本来要堵的洞一模一样。
     * 真正该看的只有 waitingOnQuestion：pendingAsk 还在，就是没答上。
     */
    const saidNothing = result.said.length === 0 && result.answered.length === 0;
    if (saidNothing && student.waitingOnQuestion && silentRetries < MAX_SILENT_RETRIES) {
      silentRetries++;
      log('演练', `学生这一步没说话，${silentRetries}/${MAX_SILENT_RETRIES} 次重推`);
      thinking = false;
      scheduleNudge(1500 * silentRetries);
      return;
    }
    silentRetries = 0;
  } catch (e) {
    log('演练', `学生这边出错：${(e as Error).message}`);
    /**
     * 真机复现过：上游模型服务限流（DeepSeek 429），学生这一步的模型调用
     * 直接抛了异常，走的是这条 catch 分支——上面"没说话就重推"那段
     * 完全没机会生效，因为它压根没跑到 saidNothing 那句判断。
     * 限流多半是瞬时的，重试的价值跟"没说话"是一样的，用同一个计数器封顶。
     */
    if (student.waitingOnQuestion && silentRetries < MAX_SILENT_RETRIES) {
      silentRetries++;
      log('演练', `学生这一步调用出错，${silentRetries}/${MAX_SILENT_RETRIES} 次重推`);
      thinking = false;
      scheduleNudge(1500 * silentRetries);
      return;
    }
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
/**
 * 多久没动静算收工。
 *
 * 下限是"一次模型调用最慢要多久"——比它短的话，慢模型会被误判成卡死。
 * ox-alpha 实测单次 10~20 秒，留三倍余量。
 */
const QUIET_MS = Number(flag('quiet-sec', '90')) * 1000;

function armQuiet(ms = QUIET_MS): void {
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    if (finished) return;
    log('演练', '两边都没动静了，收工。');
    void finish();
  }, ms);
}

function askForState(): void {
  const enc = encoding.createEncoder();
  syncProtocol.writeSyncStep1(enc, doc);
  sendFrame(FrameTag.Sync, encoding.toUint8Array(enc));
}

ws.on('open', () => {
  askForState();

  /**
   * 握手要会重发。服务端刚启动或房间刚被换出内存时会丢掉第一次 step1
   * 且不补发——实测演练开场看到"画布上有 0 个图元"，而磁盘上那间房
   * 明明有 8 个。学生于是对着一片空白说"题目还没放上来"，整场作废。
   */
  let tries = 0;
  const retry = setInterval(() => {
    if (started || gotServerState) return clearInterval(retry);
    if (++tries > 7) {
      clearInterval(retry);
      console.error(`重发 ${tries - 1} 次握手仍没收到房间「${roomId}」的状态，退出。`);
      process.exit(1);
    }
    askForState();
  }, 2000);
});

let started = false;
let gotServerState = false;
let settle: NodeJS.Timeout | null = null;

ws.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
  const { tag, payload } = decodeFrame(bytes);

  if (tag === FrameTag.Sync || tag === FrameTag.SyncAI) {
    const dec = decoding.createDecoder(payload);
    const enc = encoding.createEncoder();
    /**
     * 0 是 step1（服务端来要我们的状态），1/2 才是它把内容给了我们。
     *
     * 不区分的话，收到一条 step1 就开始计"安静 500ms"，然后在**空文档**上
     * 开场——注释一直写着"同步完成再开口"，而实现等的是"没人说话"，
     * 这两件事在服务端慢一点的时候完全不是一回事。
     */
    const kind = syncProtocol.readSyncMessage(dec, enc, doc, 'remote');
    if (kind !== syncProtocol.messageYjsSyncStep1) gotServerState = true;
    if (encoding.length(enc) > 0) sendFrame(FrameTag.Sync, encoding.toUint8Array(enc));

    // 同步完成再开口：文档还空着的时候看画布只会看到一片空白
    if (!started && gotServerState) {
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
  /**
   * 老师那边**有任何动静**就重新计时。
   *
   * 早先这个计时器只在老师"说话"时重置，于是老师埋头调工具的那段时间被算成
   * 闲置——换到 stealth/ox-alpha 之后一轮要三次模型调用、四十多秒，
   * 演练脚本在它干到一半时判它没动静收工，然后给出一份"老师问了 0 次"的
   * 判分表。那份表看起来像产品坏了，其实是尺子坏了。
   *
   * "两边都没动静"应该是字面意思：真的什么都没发生。
   */
  if (msg.t.startsWith('agent.') || msg.t === 'session.mode') armQuiet();

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
      if (msg.mode === 'assist' && started) setTimeout(() => void finish(), 2500);
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
    case 'error':
      tape.serverErrors.push({ message: msg.message, ...(msg.detail ? { detail: msg.detail } : {}) });
      log('服务端 ✗', `${msg.message}${msg.detail ? `：${msg.detail}` : ''}`);
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
  } catch (e) {
    /**
     * 真机复现过：开场这一步撞上上游模型限流（429），这里原来没有
     * catch，异常直接冒出去把整个 Node 进程带崩——录像脚本、这场演练
     * 的全部进度，全都随着这一次瞬时的限流一起没了。nudgeStudent() 里
     * 后续的每一步都有这层保护，唯独最开场这一步漏掉了。
     * 限流多半是瞬时的，不该让一次网络抖动搭上整个进程。
     */
    log('演练', `开场这一步出错：${(e as Error).message}`);
  } finally {
    thinking = false;
    // 开场这条路上没有 turn.end 可以挂，静默计时得在这儿起
    armQuiet();
  }
}

/* ------------------------------------------------------------------ *
 * 判分
 * ------------------------------------------------------------------ */

async function finish(): Promise<void> {
  if (finished) return;
  finished = true;
  if (idleTimer) clearTimeout(idleTimer);

  /**
   * 讲完了，图谱上到底长出东西没有？
   *
   * 这一条本来是手工 curl 看一眼的，挪进来当成判分项——
   * "学生学完之后掌握度要更新"是这套东西的目的本身，
   * 留在手工验证里，下次改坏了没人会发现。
   */
  /**
   * 老师讲的是不是**画布上这道题**。
   *
   * 这道闸是被一次真实事故逼出来的：H9 的题目原文就在画布上（纯文字，
   * 连读图都不需要），老师却讲了一道自己编的「直线 y=x+1 与圆 x²+y²=4」，
   * 而当时的判分表打了「辅导全过程跑通」——它检查拆题、判定、收尾，
   * 唯独不检查讲的是不是这道题。一场围绕虚构题目的辅导，所有检查都说很好。
   *
   * 第一版我比的是"提问里有没有题面上没有的数"，结果**抓不住这次事故**：
   * 编出来的 y=x+1、x²+y²=4 用的 1、2、4 恰好题面里也都有。小数字必然重合，
   * 这个信号太弱。抓不住本案的检查比没有检查更糟——它只提供虚假的安心。
   *
   * 现在比的是**特征片段**：题面里带数字的连续块（`x²+y²−4x+2y−4`、`3x+4y+5`、
   * `sin2α`、`α+π/4`），去掉空格后看老师说过的话里有没有出现过。
   * 拿两场真实记录验过：编题那场一个都没命中，讲对那场命中两个。
   */
  const textOnCanvas = scene
    .all()
    .map((sh) => ((sh as { text?: string }).text ?? ''))
    .join(' ');
  const marksOf = (text: string): string[] => {
    const out = new Set<string>();
    for (const m of text.replace(/\s+/g, '').matchAll(/[0-9a-zA-Zα-ωΑ-Ω²³√π/+\-−]{3,}/g)) {
      if (/[0-9]/.test(m[0])) out.add(m[0]);
    }
    return [...out];
  };
  const canvasMarks = marksOf(textOnCanvas);
  const teacherFlat = [...tape.asks, ...tape.teacherSays].join(' ').replace(/\s+/g, '');
  const groundedMarks = canvasMarks.filter((t) => teacherFlat.includes(t));

  const kg = await fetchMastery();

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

  /**
   * 拆的条数够不够题目原文标出来的那么多。
   *
   * 真机复现过：一道标了 (1)~(5) 五问的题，tutor_plan 只列了 4 条像
   * "理解题目条件""计算 AD""验证结果""总结思路"这样的过程性条目——
   * 不是题目问的那五问本身。结果辅导围着"求 AD"打转了大半场，
   * 内切圆半径、外接圆半径从头到尾没被问过，清单却全部打勾，
   * tutor_finish 也顺利通过——因为清单本身就是缩水的，"账平了"这个
   * 信号建立在一份自己造的、缩水的账本上，单看"打勾了没"看不出这个问题。
   *
   * 数的是题目原文里 (1)(2)(3)…… 这类小问编号出现了几个，跟清单条数比。
   * 数字用宽松的英文/中文括号都认，因为题面既可能是中文也可能是英文原题。
   */
  const numberedParts = new Set(
    [...textOnCanvas.matchAll(/[(（]\s*(\d{1,2})\s*[)）]/g)].map((m) => m[1]),
  ).size;
  add(
    numberedParts === 0 || tape.todos.length >= numberedParts,
    '拆题拆全了',
    numberedParts === 0
      ? '题目原文里没有找到 (1)(2)(3) 这类小问编号，这项没法判'
      : tape.todos.length >= numberedParts
        ? `题目标了 ${numberedParts} 问，清单拆了 ${tape.todos.length} 条，够`
        : `题目标了 ${numberedParts} 问，清单只拆了 ${tape.todos.length} 条——` +
          `很可能把题目自己的问题揉成了几条"流程步骤"，账本本身就是缩水的`,
  );

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
    tape.toolErrors.length === 0 && tape.serverErrors.length === 0,
    '工具没真出错',
    tape.toolErrors.length === 0
      ? '一次都没有'
      : tape.toolErrors.map((e) => `${e.name}: ${e.error}`).join('；'),
  );

  /**
   * 只在"真讲完了"的局面下要求图谱更新。
   *
   * 学生半路要答案走人时没长东西是对的——他并没有学完，
   * 那时候还往图谱上记，记的就是假账。
   */
  const finishedProperly = tape.modes.at(-1)?.note?.includes('到此结束') ?? false;
  if (finishedProperly) {
    add(
      kg !== null && kg.count > 0,
      '图谱长出东西了',
      kg === null
        ? '问不到 /kg/mastery，服务端起了吗？'
        : kg.count > 0
          ? `${kg.count} 个知识点：${kg.summary}`
          : '一个知识点都没记上。先看服务端日志里有没有 kg.learned；没有的话查 tutor_judge 有没有跑过，以及这道题的小问文字能不能在图谱里认出知识点',
    );
    if (kg && kg.count > 0) {
      // 全程被引导着做对的，不该显示成"已掌握"——那是这套掌握度的立身之本
      const overclaimed = kg.rows.filter((r) => r.band === 'mastered');
      add(
        overclaimed.length === 0,
        '没把"被教会"记成"已掌握"',
        overclaimed.length === 0
          ? '全程引导，掌握度停在"学着呢"，符合预期'
          : `这几个被记成已掌握了：${overclaimed.map((r) => r.name).join('、')}`,
      );
    }
  }

  /**
   * 这两条曾经是死代码。
   *
   * 我把它们插在了 `if (!entered && wantedOut)`（学生一上来就要答案）那个
   * 分支里——那条路几乎从不执行，而我只看过主分支打出来的判分表，
   * 于是「服务端没报错」加进来大半天，一次都没跑过，判分表照样满屏对勾。
   * **一道从不执行的检查，和一道永远通过的检查，长得一模一样。**
   */
  add(
    canvasMarks.length === 0 || tape.asks.length === 0 || groundedMarks.length > 0,
    '讲的是画布上这道题',
    canvasMarks.length === 0
      ? '题面上没有可比对的记号，这项没法判'
      : tape.asks.length === 0
        ? '没提过问'
        : groundedMarks.length > 0
          ? `引用了题面上的 ${groundedMarks.slice(0, 4).join('、')}`
          : `整场没引用过题面上任何一处记号（题面有 ${canvasMarks.slice(0, 4).join('、')}）——很可能在讲另一道题`,
  );

  add(
    tape.serverErrors.length === 0,
    '服务端没报错',
    tape.serverErrors.length === 0
      ? '一次都没有'
      : tape.serverErrors.map((e) => `${e.message}${e.detail ? `（${e.detail}）` : ''}`).join('；'),
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

interface KgSnap {
  count: number;
  summary: string;
  rows: Array<{ name: string; level: number; band: string }>;
}

/**
 * 问一次服务端：这个学生现在图谱上是什么样。
 *
 * 查的是 **uid**，不是房间名。掌握度跟着人走，跨画布累计——
 * 按房间名查的话，无论学生学到了什么都是 0，判分表会理直气壮地写着
 * "一个知识点都没记上，多半是模型没带 conceptIds"。
 * 那句话我信过一次，往错的方向查了一整轮。
 */
async function fetchMastery(): Promise<KgSnap | null> {
  try {
    const r = await fetch(`${'http://localhost:'}${PORT}/kg/mastery/${encodeURIComponent(uid)}`);
    if (!r.ok) return null;
    const d = (await r.json()) as { mastery?: Array<{ name: string; level: number; band: string }> };
    const rows = d.mastery ?? [];
    return {
      count: rows.length,
      summary: rows.map((m) => `${m.name} ${m.level.toFixed(2)}(${m.band})`).join('、'),
      rows,
    };
  } catch {
    return null;
  }
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

/**
 * 整体兜底：别让一次跑飞的演练挂在那儿。
 *
 * 原来写死 10 分钟——够用直到"提问前先指图"改成硬闸那次：struggling
 * 人设一场五问的辅导，老师光是重试没查到的图元 id 就吃掉了好几次
 * 完整的模型往返，五问还没讲完这堵兜底就先把它拦腰砍了。
 * 讲得越全面本来就该花更多真实时间，兜底不该比这更紧。
 */
const wallMin = Number(flag('max-min', '10'));
setTimeout(() => {
  log('演练', `超时（${wallMin} 分钟），强制收尾。`);
  void finish();
}, wallMin * 60_000);
