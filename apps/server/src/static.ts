import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';

/**
 * 把前端构建产物发出去。
 *
 * 为什么让 Node 自己发静态文件，而不是交给 nginx：
 * 挂载前缀（`/apps`）如果在 nginx 和应用里各配一遍，对不上时的表现是白屏
 * 或者一堆 404，而两边配置都"看着没错"——这类问题很难查。
 * 现在前缀只有一个来源（BASE_PATH），静态页、API、WebSocket 都从它推导。
 *
 * 量级也撑得住：一个 SPA 就几个文件，操作系统的文件缓存比什么都快。
 * 真要上 CDN 再说，那时候把这一层摘掉就行。
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export const hasWeb = (): boolean => config.webDist.length > 0;

/**
 * 试着把 pathname 当静态文件发出去，发不了返回 false。
 *
 * 找不到文件时回落到 index.html —— 这是 SPA 的必备：
 * 用户直接打开 `/apps/?view=kg` 或者刷新页面，路径不对应任何真实文件，
 * 但那是前端路由要处理的，不是 404。
 */
export async function serveWeb(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!hasWeb()) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const root = resolve(config.webDist);
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, rel);

  // 目录穿越：normalize 之后仍然可能跑出去（比如 %2e%2e），落地前再确认一次
  if (!file.startsWith(root)) return false;

  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, 'index.html');
    info = await stat(file).catch(() => null);
  }
  if (!info?.isFile()) {
    // SPA 回落
    file = join(root, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info?.isFile()) return false;
  }

  const ext = extname(file).toLowerCase();
  const isHtml = ext === '.html';
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': info.size,
    /**
     * 带 hash 的构建产物可以长期缓存；index.html 绝不能——
     * 它里面写着当前该加载哪个 hash 的 js，缓存住了就等于永远发旧版本。
     */
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}
