/**
 * 被动旁听某个房间的 agent.tool 事件，把 canvas_create / tutor_finish 的
 * 完整 args + 结果写到一个 JSONL 文件里，用于事后排查 diagramBlockCount
 * 逃生阀 + 最终答案漏写画布的问题——tutor-drill.ts 自己的判分只记错误
 * 文案，不记新写的文字内容，看不出模型到底想写什么、写到哪儿去了。
 *
 * 临时调查脚本，用完可删。
 *
 * 用法：npx tsx scripts/watch-tools.ts <roomId> [outFile]
 */
import { WebSocket } from 'ws';
import { appendFileSync, writeFileSync } from 'node:fs';
import { FrameTag, decodeFrame } from '@canvai/protocol';

const roomId = process.argv[2];
if (!roomId) {
  console.error('用法：npx tsx scripts/watch-tools.ts <roomId> [outFile]');
  process.exit(1);
}
const outFile = process.argv[3] ?? `/tmp/watch-${roomId}.jsonl`;
const PORT = process.env.PORT ?? '3001';

writeFileSync(outFile, '');
console.log(`旁听房间「${roomId}」，写入 ${outFile}`);

const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${roomId}&uid=watcher&name=%E6%97%81%E5%90%AC`);
ws.binaryType = 'arraybuffer';

ws.on('open', () => console.log('已连接，开始旁听…'));

ws.on('message', (data: ArrayBuffer | Buffer) => {
  const bytes = new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
  const { tag, payload } = decodeFrame(bytes);
  if (tag !== FrameTag.Control) return;
  const msg = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;

  const line = JSON.stringify({ ts: new Date().toISOString(), msg });
  appendFileSync(outFile, line + '\n');

  if (msg.t === 'agent.tool') {
    const call = msg.call as { name: string; state: string; error?: string; args?: unknown };
    if (call.name === 'canvas_create' || call.name === 'tutor_finish' || call.name === 'canvas_ink') {
      const stamp = new Date().toISOString().slice(11, 19);
      if (call.state === 'error') {
        console.log(`[${stamp}] ✗ ${call.name} — ${call.error}`);
        console.log(`         args: ${JSON.stringify(call.args).slice(0, 400)}`);
      } else if (call.state === 'ok') {
        console.log(`[${stamp}] ✓ ${call.name}`);
        console.log(`         args: ${JSON.stringify(call.args).slice(0, 400)}`);
      }
    }
  } else if (msg.t === 'session.mode') {
    console.log(`[mode] → ${(msg as { mode: string }).mode} ${(msg as { note?: string }).note ?? ''}`);
  } else if (msg.t === 'agent.judge') {
    console.log(`[judge] ${(msg as { verdict: string }).verdict}`);
  }
});

ws.on('error', (e) => {
  console.error('连接失败：', e.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  ws.close();
  process.exit(0);
});
