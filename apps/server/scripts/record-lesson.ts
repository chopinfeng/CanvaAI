/**
 * 把一整场辅导录下来。
 *
 * 录的是**真实浏览器里的真实画布**，不是回放或重演：Playwright 开一个
 * Chromium 连到房间，学生 Agent 以另一个 WebSocket 客户端身份进同一个房间，
 * 两边通过 CRDT 同步。所以视频里出现的每一笔都是当场发生的。
 *
 * 为什么不截图拼帧：拼出来的东西看着像录像，但丢掉了所有中间状态——
 * 而"AI 画到一半"和"学生正在打字"恰恰是这个产品要展示的东西。
 *
 * 用法：npx tsx scripts/record-lesson.ts --room amc --request "..." [--persona careless]
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '../../../.work/recordings');
const argv = process.argv.slice(2);
const arg = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const room = arg('room', 'amc');
const persona = arg('persona', 'careless');
const request = arg('request', '给我讲这道题');
const webPort = arg('web-port', '5173');
const maxMin = Number(arg('max-min', '25'));

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    recordVideo: { dir: OUT, size: { width: 1600, height: 1000 } },
  });
  const page = await ctx.newPage();

  // 页面里的报错直接打出来——录像里看不出 JS 崩了，只会看到画布不动
  page.on('pageerror', (e) => console.error('  [页面报错]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text().slice(0, 160));
  });

  await page.goto(`http://localhost:${webPort}/?room=${room}`, { waitUntil: 'networkidle' });
  // 等画布上真的有东西了再开始，否则视频开头是几秒空白
  // 这段字符串在浏览器里跑，不在 Node 里——所以用字符串形式，别让 tsc 去解析 document
  await page.waitForFunction("document.querySelectorAll('canvas').length > 0", null, { timeout: 20_000 });
  await page.waitForTimeout(1500);

  console.log(`录像已开始：房间 ${room}，人设 ${persona}`);
  console.log(`学生的第一句：「${request}」\n`);

  /* ---- 学生 Agent 作为另一个客户端进场 ---- */
  const drill = spawn(
    'npx',
    ['tsx', join(here, 'tutor-drill.ts'), '--room', room, '--persona', persona, '--request', request, '--max-turns', '40'],
    { cwd: join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  drill.stdout.on('data', (b: Buffer) => process.stdout.write(b));
  drill.stderr.on('data', (b: Buffer) => process.stderr.write(b));

  const code = await new Promise<number>((resolve) => {
    const killer = setTimeout(() => {
      console.error(`\n超过 ${maxMin} 分钟，掐掉——录像仍然保留`);
      drill.kill('SIGTERM');
    }, maxMin * 60_000);
    drill.on('exit', (c) => {
      clearTimeout(killer);
      resolve(c ?? 1);
    });
  });

  // 结尾多录两秒：最后一步（撒花、收尾语）往往还在画
  await page.waitForTimeout(2500);

  const video = page.video();
  await ctx.close(); // 必须先关 context，视频文件这时候才落地
  await browser.close();

  let saved = '(没生成)';
  if (video) {
    const raw = await video.path();
    const stamp = (await readdir(OUT)).length;
    const dest = join(OUT, `${room}-${persona}-${stamp}.webm`);
    await rename(raw, dest);
    saved = dest;
  }
  console.log(`\n录像：${saved}`);
  console.log(`学生 Agent 退出码：${code}${code === 0 ? '（辅导跑完了）' : '（有问题，看上面）'}`);
  process.exit(code);
}

void main();
