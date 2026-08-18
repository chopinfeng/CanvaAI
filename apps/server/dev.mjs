/**
 * 开发用守护进程。
 *
 * 起因：服务端被原生模块 panic 掀翻后，`tsx watch` 不会把它拉起来，
 * 端口就一直空着。前端只会不停打印 ECONNREFUSED，页面看着"还在"，
 * 实际早断了——排查时容易被这个假象带偏。
 *
 * 现在崩溃会立刻重启并在终端说清楚，同时日志里有完整现场（logs/*.crash-*.jsonl）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, 'node_modules', '.bin', 'tsx');
const entry = join(here, 'src', 'index.ts');

/** 短时间内反复崩溃说明是启动就挂，别无限重启刷屏 */
const WINDOW_MS = 60_000;
const MAX_RESTARTS = 8;
const restarts = [];

let child = null;
let stopping = false;

function start() {
  child = spawn(tsx, ['watch', entry], { stdio: 'inherit', env: process.env });

  child.on('exit', (code, signal) => {
    if (stopping) return;

    const now = Date.now();
    while (restarts.length > 0 && now - restarts[0] > WINDOW_MS) restarts.shift();
    restarts.push(now);

    const how = signal ? `信号 ${signal}` : `退出码 ${code}`;
    if (code === 0 && !signal) {
      console.log(`\n[dev] 服务端正常退出，守护进程结束。`);
      process.exit(0);
    }

    if (restarts.length > MAX_RESTARTS) {
      console.error(
        `\n[dev] 服务端在 ${WINDOW_MS / 1000}s 内崩溃了 ${restarts.length} 次（最后一次：${how}），不再重启。\n` +
          `[dev] 多半是启动阶段就报错。看一眼 logs/ 目录下最新的 .crash-*.jsonl。\n`,
      );
      process.exit(1);
    }

    console.error(`\n[dev] 服务端异常退出（${how}），1s 后重启。现场见 logs/ 下最新的 .crash-*.jsonl\n`);
    setTimeout(start, 1000);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    child?.kill(sig);
    setTimeout(() => process.exit(0), 500);
  });
}

start();
