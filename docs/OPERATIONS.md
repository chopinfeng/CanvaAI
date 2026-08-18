# 运行与排查

## 日志在哪

```
logs/server-YYYY-MM-DD.jsonl          当天全部事件，一行一条 JSON
logs/server-YYYY-MM-DD.crash-<ts>.jsonl  崩溃现场：出事前最近 300 条事件
```

`/health` 会直接告诉你当前日志文件路径：

```bash
curl -s localhost:3001/health
```

常用查询：

```bash
jq -r 'select(.level=="error" or .level=="fatal") | "\(.t) \(.event) \(.message // .stderr // "")"' logs/*.jsonl
```

```bash
jq -r 'select(.event=="agent.usage") | "\(.t) prompt=\(.prompt) 缓存\(.cacheHitPct)%"' logs/*.jsonl
```

调详细程度：`.env` 里 `LOG_LEVEL=debug`，或换目录 `LOG_DIR=/somewhere`。

## 为什么日志要接管 stderr

第一次线上崩溃是 **resvg（Rust 原生模块）panic 后 abort 整个进程**。
panic 文本直接写进裸 stderr——不经过 `console`，也没有任何 JS 异常可捕获，
`try/catch`、Promise、甚至 worker_threads 都拦不住（abort 杀的是进程，不是线程）。

终端里只看得到 vite 的转发错误，完全是误导：

```
[vite] ws proxy error: Error: read ECONNRESET        ← 服务端就是在这一刻死的
[vite] ws proxy error: AggregateError [ECONNREFUSED] ← 之后都是客户端在重连一个空端口
```

所以 `log.ts` 里包了 `process.stderr.write`，原生模块的输出也会进 JSONL。
识别到 `panicked at` / `fatal runtime error` 之类的字样时，会立刻把环形缓冲
同步落盘成 `.crash-*.jsonl`。

## 已知的原生崩溃与防线

**触发条件**：SVG 里某个元素带 `marker-end`（箭头）或 `opacity<1`，
且它整个落在 `viewBox` 之外。resvg 会为这类元素分配离屏子画布，
与视口求交得到空尺寸后 `unwrap()` 了 `None`。

复现只需要截一小块局部图——比如"放大看看左上角"，是再普通不过的操作。

**两道防线**：

1. `canvas-core/svg.ts` 序列化时裁掉与渲染区域不相交的图元（留 64px 余量）。
   从源头上不产生这种输入，顺便大幅减少 SVG 体积。
2. `apps/server/src/render-worker.mjs` 把渲染放在独立子进程。
   即使还有未知的 panic 输入，最坏结果也只是这一次截图失败——
   `canvas_snapshot` 会自动退化成结构化描述继续工作，画布和所有连接不受影响。

回归测试在 `apps/server/src/__tests__/rasterizer.test.ts`。
其中一条故意喂进事故 SVG：**如果隔离失效，它不会"测试失败"，而是带着整个测试进程一起消失。**

## 服务端崩了怎么办

`pnpm dev` 现在走 `apps/server/dev.mjs` 守护进程：异常退出会自动重启，
终端里说清楚原因并指向崩溃现场文件。60 秒内崩超过 8 次就停下不再重启
（那通常意味着启动阶段就报错，重启没有意义）。

想绕过守护进程直接跑：`pnpm --filter @canvai/server dev:raw`。

## 前端看到的现象与真实原因对照

| 终端/控制台现象 | 实际原因 | 去哪儿看 |
|---|---|---|
| `ws proxy error: ECONNREFUSED` 刷屏 | 服务端进程已死 | `logs/*.crash-*.jsonl` |
| 页面显示"已断开，重连中…" | 同上，客户端在退避重连 | 同上 |
| `[server] Agent: 未启用` | `.env` 没读到 key | 启动日志的 `env=` 字段列出了实际读取的文件 |
| 截图返回 `degraded: true` | 渲染子进程失败或没装 resvg | `logs` 里的 `rasterizer.failed` |
