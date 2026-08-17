import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { config, envFiles, hasAgent, hasVision } from './config.ts';
import { closeIdleRooms, getRoom, saveAllRooms } from './room.ts';
import { initRasterizer } from './rasterizer.ts';

const server = createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin === config.webOrigin) res.setHeader('access-control-allow-origin', origin);

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        agent: hasAgent() ? config.deepseek.model : null,
        vision: hasVision() ? config.vlm.model : null,
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (socket: WebSocket, req) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') ?? 'default';
  const user = {
    id: url.searchParams.get('uid') ?? `u_${Math.random().toString(36).slice(2, 8)}`,
    name: url.searchParams.get('name') ?? '访客',
    color: url.searchParams.get('color') ?? '#2563eb',
  };

  const room = await getRoom(roomId);
  room.join(socket, user);

  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    try {
      room.handleFrame(socket, new Uint8Array(buf));
    } catch (e) {
      console.error('[ws] 处理帧失败', e);
    }
  });

  socket.on('close', () => {
    room.leave(socket);
  });

  socket.on('error', (e) => {
    console.error('[ws] socket error', e);
    room.leave(socket);
  });
});

// 空房间定期落盘并释放
setInterval(() => void closeIdleRooms(), 60_000).unref();

await initRasterizer();

server.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}  ws://localhost:${config.port}/ws`);
  console.log(`[server] 配置来自: ${envFiles.length > 0 ? envFiles.join(', ') : '(没找到任何 .env，只用了环境变量)'}`);
  console.log(`[server] Agent: ${hasAgent() ? config.deepseek.model : '未启用'}`);
  if (!hasAgent()) {
    console.warn(
      `[server] ↑ .env 里没读到 DEEPSEEK_API_KEY。检查上面列出的文件里是否有这一行（等号后不要留引号或空格）。`,
    );
  }
  console.log(`[server] 视觉: ${hasVision() ? config.vlm.model : '未启用'}`);
});

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[server] 正在保存所有房间并退出…');
    // 先停止接受新连接，再保存所有房间（不只是空房间）
    wss.close();
    server.close();
    void saveAllRooms()
      .then(() => console.log('[server] 已保存'))
      .catch((e) => console.error('[server] 保存失败', e))
      .finally(() => process.exit(0));
  });
}
