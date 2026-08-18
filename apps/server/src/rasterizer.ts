import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rasterizer } from '@canvai/agent';
import { log } from './log.ts';

/**
 * SVG → PNG。
 *
 * 渲染跑在独立子进程里，因为 resvg 会在某些输入上 panic 并 abort 整个进程。
 * 详见 render-worker.mjs 顶部的说明。代价是每次截图多 ~100ms 的进程启动，
 * 而 canvas_snapshot 本来就是低频操作（大多数判断走结构化查询），换来的是
 * "截图失败" 而不是 "所有人的画布连接一起断掉"。
 */

const WORKER = join(dirname(fileURLToPath(import.meta.url)), 'render-worker.mjs');
const TIMEOUT_MS = 15_000;
/** 单张图的像素上限，防止一次截图把内存吃光 */
const MAX_PIXELS = 40_000_000;

let cached: Rasterizer | undefined;
let initialized = false;

export async function initRasterizer(): Promise<Rasterizer | undefined> {
  if (initialized) return cached;
  initialized = true;

  if (!existsSync(WORKER)) {
    log.warn('rasterizer.missing_worker', { path: WORKER });
    return undefined;
  }

  try {
    await import('@resvg/resvg-js');
  } catch {
    log.info('rasterizer.unavailable', { note: '未安装 @resvg/resvg-js，canvas_snapshot 将退化为结构化描述' });
    return undefined;
  }

  cached = { render: renderInChild };
  log.info('rasterizer.ready', { mode: 'child-process', worker: WORKER });
  return cached;
}

export const getRasterizer = (): Rasterizer | undefined => cached;

export class RenderError extends Error {}

function renderInChild(svg: string, scale: number): Promise<Uint8Array> {
  const px = estimatePixels(svg, scale);
  if (px > MAX_PIXELS) {
    return Promise.reject(new RenderError(`目标图像太大（约 ${Math.round(px / 1e6)} 百万像素），请缩小 region 或 scale`));
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });

    const out: Buffer[] = [];
    let errText = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      log.warn('rasterizer.timeout', { ms: TIMEOUT_MS });
      reject(new RenderError(`渲染超时（${TIMEOUT_MS}ms）`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      errText += d.toString('utf8');
    });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.error('rasterizer.spawn_failed', { message: e.message });
      reject(new RenderError(`无法启动渲染进程: ${e.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0 && out.length > 0) {
        resolve(new Uint8Array(Buffer.concat(out)));
        return;
      }

      // 这里就是原本会杀掉整个服务端的路径，现在只是一次失败
      const panicked = /panicked at|fatal runtime error/.test(errText);
      log.error('rasterizer.failed', {
        code,
        signal,
        panicked,
        stderr: errText.trim().slice(0, 800),
      });
      reject(
        new RenderError(
          panicked
            ? '渲染引擎在这张图上崩溃了（已隔离在子进程，服务未受影响）'
            : `渲染进程退出码 ${code}${signal ? ` signal=${signal}` : ''}: ${errText.trim().slice(0, 200)}`,
        ),
      );
    });

    child.stdin.on('error', () => {
      /* 子进程提前退出时会 EPIPE，close 事件里统一处理 */
    });
    child.stdin.end(JSON.stringify({ svg, scale }));
  });
}

/** 从 SVG 头部的 width/height 估算像素数 */
function estimatePixels(svg: string, scale: number): number {
  const w = Number(/\bwidth="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 0);
  const h = Number(/\bheight="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 0);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return 0;
  return w * h * Math.max(scale, 1) ** 2;
}
