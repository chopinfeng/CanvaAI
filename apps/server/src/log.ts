import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { config } from './config.ts';

/**
 * 服务端日志。
 *
 * 为什么不用 console.log 了事：上一次崩溃是 resvg（Rust 原生模块）panic 后
 * abort 掉整个进程，panic 文本直接写进**裸 stderr**，既不经过 console，
 * 也没有任何 JS 异常可捕获。终端里滚过去就没了，事后完全无从查起。
 *
 * 所以这里做三件事：
 * 1. 结构化 JSONL 落盘，一行一个事件，事后可 grep/jq
 * 2. **接管 process.stderr.write**，把原生模块的输出也一并留档
 * 3. 环形缓冲最近 N 条事件；进程要死的时候同步写出来，还原崩溃前的现场
 */

export type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  t: string;
  level: Level;
  event: string;
  [k: string]: unknown;
}

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const minRank = LEVEL_RANK[(config.logLevel as Level) in LEVEL_RANK ? (config.logLevel as Level) : 'info'];

const RING_SIZE = 300;
const ring: LogEntry[] = [];

let logFile = '';
let ready = false;

function ensureFile(): string {
  if (!ready) {
    try {
      mkdirSync(config.logDir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      logFile = join(config.logDir, `server-${day}.jsonl`);
      ready = true;
    } catch (e) {
      // 落盘失败也不能让服务挂掉，退化成只有控制台
      process.stdout.write(`[log] 无法创建日志目录 ${config.logDir}: ${(e as Error).message}\n`);
      ready = true;
      logFile = '';
    }
  }
  return logFile;
}

/** 同步写：崩溃处理里异步写根本来不及 */
function writeLine(entry: LogEntry): void {
  const file = ensureFile();
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // 磁盘满/权限问题：放弃这一行，但绝不影响主流程
  }
}

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const entry: LogEntry = { t: new Date().toISOString(), level, event, ...fields };

  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  if (LEVEL_RANK[level] < minRank) return;

  writeLine(entry);

  // 控制台保持人类可读
  const extras = Object.entries(fields)
    .filter(([k]) => k !== 'stack')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : inspect(v, { depth: 2, breakLength: 120 })}`)
    .join(' ');
  const line = `${TAG[level]} ${event}${extras ? ` ${extras}` : ''}\n`;
  if (LEVEL_RANK[level] >= LEVEL_RANK.warn) originalStderrWrite.call(process.stderr, line);
  else process.stdout.write(line);
  if (typeof fields.stack === 'string') originalStderrWrite.call(process.stderr, `${fields.stack}\n`);
}

const TAG: Record<Level, string> = {
  debug: '[·]',
  info: '[i]',
  warn: '[!]',
  error: '[✗]',
  fatal: '[💀]',
};

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
  /** 只在进程要死的时候用；会连同环形缓冲一起同步落盘 */
  fatal: (event: string, fields?: Record<string, unknown>) => {
    emit('fatal', event, fields);
    dumpRing(event);
  },
  file: () => ensureFile(),
  recent: (): readonly LogEntry[] => ring,
};

/** 把崩溃前的最近事件单独存一份，省得在整天的日志里翻 */
function dumpRing(reason: string): void {
  const file = ensureFile();
  if (!file) return;
  try {
    const crashFile = file.replace(/\.jsonl$/, `.crash-${Date.now()}.jsonl`);
    const header = JSON.stringify({
      t: new Date().toISOString(),
      level: 'fatal',
      event: 'crash.context',
      reason,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1e6),
      node: process.version,
    });
    appendFileSync(crashFile, `${header}\n${ring.map((e) => JSON.stringify(e)).join('\n')}\n`);
    originalStderrWrite.call(process.stderr, `[💀] 崩溃现场已保存: ${crashFile}\n`);
  } catch {
    // 尽力而为
  }
}

/* ------------------------------------------------------------------ *
 * 接管 stderr —— 原生模块的 panic 只走这里
 * ------------------------------------------------------------------ */

const originalStderrWrite = process.stderr.write.bind(process.stderr);
let teeing = false;

export function teeStderrToLog(): void {
  if (teeing) return;
  teeing = true;

  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');

    // 别把我们自己刚打印的那行又记一遍
    if (!text.startsWith('[!]') && !text.startsWith('[✗]') && !text.startsWith('[💀]')) {
      const trimmed = text.trimEnd();
      if (trimmed) {
        const native = /panicked at|fatal runtime error|Segmentation fault|Abort trap/.test(trimmed);
        writeLine({
          t: new Date().toISOString(),
          level: native ? 'fatal' : 'warn',
          event: native ? 'native.panic' : 'stderr',
          text: trimmed,
        });
        if (native) dumpRing('native.panic');
      }
    }

    return (originalStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
}

/* ------------------------------------------------------------------ *
 * 进程级兜底
 * ------------------------------------------------------------------ */

export interface CrashHooks {
  /** 退出前尽量把数据存下来 */
  onFatal?: () => Promise<void>;
}

export function installCrashHandlers(hooks: CrashHooks = {}): void {
  teeStderrToLog();

  process.on('uncaughtException', (err, origin) => {
    log.fatal('uncaughtException', { origin, message: err.message, stack: err.stack });
    void finish(hooks, 1);
  });

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    // 一次没接住的 Promise 不该毁掉所有人的画布，记下来继续跑
    log.error('unhandledRejection', { message: err.message, stack: err.stack });
  });

  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning') return;
    log.warn('node.warning', { name: w.name, message: w.message });
  });

  process.on('exit', (code) => {
    if (code !== 0) log.warn('process.exit', { code });
  });
}

let finishing = false;
async function finish(hooks: CrashHooks, code: number): Promise<void> {
  if (finishing) return;
  finishing = true;
  try {
    await Promise.race([
      hooks.onFatal?.() ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  } finally {
    process.exit(code);
  }
}
