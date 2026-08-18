/**
 * SVG → PNG 渲染工作进程。
 *
 * 独立进程的唯一原因：resvg 是 Rust 原生模块，遇到某些输入会 panic 并
 * **abort 整个进程**——JS 侧没有任何异常可捕获，try/catch、Promise、
 * 甚至 worker_threads 都拦不住（abort 杀的是进程，不是线程）。
 *
 * 已知会触发的输入（见 canvas-core/svg.ts 的裁剪逻辑）：
 * 元素带 marker-end 或 opacity<1，且整个落在 viewBox 之外时，
 * resvg 为它分配离屏子画布、与视口求交得到空尺寸，然后 unwrap 了 None。
 *
 * 隔离之后最坏情况只是这一次截图失败，画布和所有人的连接都还在。
 *
 * 协议：stdin 收 JSON {svg, scale}，成功时 stdout 输出 PNG 原始字节，
 * 失败时非零退出，stderr 留给上层记录。
 */
import { Resvg } from '@resvg/resvg-js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let req;
try {
  req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch (e) {
  process.stderr.write(`render-worker: 输入不是合法 JSON: ${e.message}\n`);
  process.exit(2);
}

try {
  const resvg = new Resvg(req.svg, { fitTo: { mode: 'zoom', value: req.scale ?? 1 } });
  process.stdout.write(resvg.render().asPng());
} catch (e) {
  process.stderr.write(`render-worker: 渲染失败: ${e.message}\n`);
  process.exit(3);
}
