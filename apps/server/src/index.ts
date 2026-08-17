import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { config, hasAgent, hasVision } from './config.ts';
import { closeIdleRooms, getRoom } from './room.ts';
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
  console.log(`[server] Agent: ${hasAgent() ? config.deepseek.model : '未启用（缺 DEEPSEEK_API_KEY）'}`);
  console.log(`[server] 视觉: ${hasVision() ? config.vlm.model : '未启用'}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log('\n[server] 正在保存并退出…');
    void closeIdleRooms().finally(() => process.exit(0));
  });
}
