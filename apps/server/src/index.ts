import { createServer } from 'node:http';
import { handleKg } from './kg-api.ts';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { MAX_ASSET_BYTES, assetStore, readAsset, sniffMime } from './assets.ts';
import { config, envFiles, hasAgent, hasVision } from './config.ts';
import { installCrashHandlers, log } from './log.ts';
import { closeIdleRooms, getRoom, saveAllRooms } from './room.ts';
import { initRasterizer } from './rasterizer.ts';
import { hasWeb, serveWeb } from './static.ts';

// 第一件事就是装崩溃处理：之后任何环节出问题都能留下现场
installCrashHandlers({ onFatal: saveAllRooms });

/**
 * 剥掉挂载前缀。
 *
 * 线上挂在 `/apps` 下，进来的是 `/apps/kg/stats`；剥成 `/kg/stats` 之后，
 * 下面所有路由不用知道自己被挂在哪儿。前缀只有一个来源（BASE_PATH），
 * 不会出现"前端按 /apps 拼、后端按根路径认"这种对不上的情况。
 */
function strip(url: string | undefined): string | null {
  const u = url ?? '/';
  const b = config.basePath;
  if (!b) return u;
  if (u === b) return '/';
  // 前缀之外的一律不认。否则 API 在 /kg 和 /apps/kg 两个地方都能打到，
  // 前端按哪个拼都"能用"，等哪天真在前缀后面加了东西才发现两边不一致。
  return u.startsWith(b + '/') ? u.slice(b.length) : null;
}

const server = createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin === config.webOrigin) res.setHeader('access-control-allow-origin', origin);

  const path = strip(req.url);
  if (path === null) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  req.url = path;

  /* ---- 知识图谱：查图、看掌握度、记练习结果 ---- */

  if (req.url?.startsWith('/kg')) {
    void handleKg(req, res);
    return;
  }

  /* ---- 图片资源 ---- */

  if (req.method === 'POST' && req.url === '/assets') {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_ASSET_BYTES) {
        res.writeHead(413).end('too large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const bytes = new Uint8Array(Buffer.concat(chunks));
      const mime = sniffMime(bytes);
      if (!mime) {
        res.writeHead(415, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: '只接受 PNG / JPEG / WebP' }));
        return;
      }
      assetStore
        .put(bytes, mime)
        .then((id) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ assetId: id }));
        })
        .catch((e: Error) => {
          log.error('asset.put_failed', { message: e.message });
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
    });
    return;
  }

  // HEAD 也要支持：标准方法，缓存校验和探活都会用到（之前只判 GET，HEAD 落到了 404）
  if ((req.method === 'GET' || req.method === 'HEAD') && req.url?.startsWith('/assets/')) {
    const id = decodeURIComponent(req.url.slice('/assets/'.length));
    void readAsset(id).then((asset) => {
      if (!asset) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': asset.mime,
        'content-length': String(asset.bytes.length),
        // 内容哈希命名，永不变，放心长缓存
        'cache-control': 'public, max-age=31536000, immutable',
        'access-control-allow-origin': '*',
      });
      res.end(req.method === 'HEAD' ? undefined : asset.bytes);
    });
    return;
  }

  /* ---- 前端页面。放在最后：先让 API 路由挑走自己的，剩下的都当页面 ---- */

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        agent: hasAgent() ? config.deepseek.model : null,
        vision: hasVision() ? config.vlm.model : null,
        uptimeSec: Math.round(process.uptime()),
        logFile: log.file(),
      }),
    );
    return;
  }

  /**
   * 剩下的都交给前端页面。
   *
   * 放在最后而不是最前：API 路由先把自己的挑走，别让一个叫 /kg 的静态目录
   * 把接口盖掉。找不到文件时 serveWeb 会回落到 index.html——
   * 用户直接打开 ?view=kg 或者刷新，走的就是这条路。
   */
  void serveWeb(req, res, req.url ?? '/').then((served) => {
    if (served) return;
    res.writeHead(404);
    res.end('not found');
  });
});

/**
 * WebSocket 的路径也要带上挂载前缀。
 *
 * ws 库是拿原始 URL 匹配的，不经过上面那次 strip——
 * 挂在 /apps 下时客户端连的是 /apps/ws，这里不跟着改就永远握不上手，
 * 而且报错长得像"服务器没开"，很难往前缀上想。
 */
const wss = new WebSocketServer({ server, path: `${config.basePath}/ws` });

wss.on('connection', (socket: WebSocket, req) => {
  // 这个回调不能是 async：里面抛出的异常会变成没人接的 Promise rejection
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const roomId = url.searchParams.get('room') ?? 'default';
    const user = {
      id: url.searchParams.get('uid') ?? `u_${Math.random().toString(36).slice(2, 8)}`,
      name: url.searchParams.get('name') ?? '访客',
      color: url.searchParams.get('color') ?? '#2563eb',
    };

    try {
      const room = await getRoom(roomId);
      const client = room.join(socket, user);
      log.info('ws.join', { room: roomId, client: client.id, user: user.name, clients: room.clientCount });

      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
        try {
          room.handleFrame(socket, new Uint8Array(buf));
        } catch (e) {
          log.error('ws.frame_failed', {
            room: roomId,
            bytes: buf.length,
            message: (e as Error).message,
            stack: (e as Error).stack,
          });
        }
      });

      socket.on('close', (code, reason) => {
        room.leave(socket);
        log.info('ws.leave', { room: roomId, code, reason: reason.toString().slice(0, 80), clients: room.clientCount });
      });

      socket.on('error', (e) => {
        log.warn('ws.socket_error', { room: roomId, message: e.message });
        room.leave(socket);
      });
    } catch (e) {
      log.error('ws.join_failed', { room: roomId, message: (e as Error).message, stack: (e as Error).stack });
      socket.close(1011, 'join failed');
    }
  })();
});

wss.on('error', (e) => log.error('wss.error', { message: e.message, stack: e.stack }));
server.on('error', (e) => log.error('http.error', { message: e.message, stack: e.stack }));

// 空房间定期落盘并释放
setInterval(() => {
  closeIdleRooms().catch((e) => log.error('rooms.close_idle_failed', { message: (e as Error).message }));
}, 60_000).unref();

await initRasterizer();

server.listen(config.port, () => {
  log.info('server.listening', {
    http: `http://localhost:${config.port}`,
    ws: `ws://localhost:${config.port}/ws`,
    env: envFiles.join(', ') || '(仅环境变量)',
    agent: hasAgent() ? config.deepseek.model : null,
    vision: hasVision() ? config.vlm.model : null,
    logFile: log.file(),
  });
  if (!hasAgent()) {
    log.warn('agent.disabled', {
      hint: `.env 里没读到 DEEPSEEK_API_KEY，检查 ${envFiles.join(', ') || '(无 .env)'}（等号后不要留引号或空格）`,
    });
  }
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('server.shutdown', { signal: sig });
    wss.close();
    server.close();
    saveAllRooms()
      .then(() => log.info('server.saved'))
      .catch((e) => log.error('server.save_failed', { message: (e as Error).message }))
      .finally(() => process.exit(0));
  });
}
