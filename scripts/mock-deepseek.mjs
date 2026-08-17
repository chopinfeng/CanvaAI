/**
 * 假的 DeepSeek 兼容端点，用来在没有 API key 的情况下跑通整条链路：
 * 真实 SSE 解析 → tool_calls 分片拼装 → 服务端执行工具 → CRDT 广播 → 浏览器落笔动画。
 */
import { createServer } from 'node:http';

let turn = 0;

const SCRIPT = [
  // 第 1 步：先看画布
  { calls: [{ name: 'canvas_query', args: { limit: 30 } }] },
  // 第 2 步：移动光标 → 画屋顶 → 说话
  {
    text: '我看到你画的墙了，',
    calls: [
      { name: 'canvas_pointer_move', args: { to: { x: 270, y: 200 }, ms: 500 } },
      {
        name: 'canvas_create',
        args: {
          shapes: [
            {
              type: 'polygon',
              x: 0,
              y: 0,
              points: [[180, 430], [270, 330], [360, 430]],
              closed: true,
              style: { stroke: '#7c3aed', strokeWidth: 3 },
              meta: { role: 'roof' },
            },
          ],
          anim: { kind: 'draw', ms: 1200, delay: 0 },
        },
      },
      { name: 'canvas_highlight', args: { ids: [], kind: 'glow', ms: 800 } },
    ],
  },
  // 第 3 步：收尾
  { text: '给你补了个三角屋顶。要不要再加个窗户？' },
];

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

createServer((req, res) => {
  if (!req.url.includes('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const step = SCRIPT[Math.min(turn++, SCRIPT.length - 1)] ?? {};
    console.log(`[mock] 第 ${turn} 次请求 → ${step.calls ? step.calls.map((c) => c.name).join(',') : '纯文本'}`);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    // 文本分片
    for (const piece of (step.text ?? '').match(/.{1,6}/gu) ?? []) {
      sse(res, { choices: [{ delta: { content: piece } }] });
    }

    // tool_calls 也分片下发，逼真地考验拼装逻辑
    (step.calls ?? []).forEach((call, index) => {
      sse(res, {
        choices: [{ delta: { tool_calls: [{ index, id: `call_${turn}_${index}`, function: { name: call.name } }] } }],
      });
      const json = JSON.stringify(call.args);
      for (const piece of json.match(/.{1,17}/gu) ?? []) {
        sse(res, { choices: [{ delta: { tool_calls: [{ index, function: { arguments: piece } }] } }] });
      }
    });

    sse(res, {
      choices: [{ delta: {}, finish_reason: step.calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 60, prompt_cache_hit_tokens: turn > 1 ? 1100 : 0 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  });
}).listen(8899, () => console.log('[mock] DeepSeek 假端点 http://127.0.0.1:8899'));
