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

## 重置状态，从头开始

状态分三处，清哪几处取决于你要重来到什么程度：

| 在哪 | 内容 | 怎么清 |
|---|---|---|
| Yjs 文档（落盘） | 画布上的图元 | seed 脚本 `--clean` |
| 服务端内存 | Agent 的对话历史、辅导账本、模式 | 面板上的「重来」，或 `--clean` 顺带 |
| 浏览器 | 聊天记录、清单、高亮、聚光 | 跟着服务端的 `session.reset` 广播一起清 |

**只想让 AI 忘掉这一轮**（画布留着）：点 AI 面板右上角的 **重来**，
再点一次「确认重来？」确认。会中断正在跑的回合、清空对话历史和辅导进度、切回普通模式。
多端同时开着的话都会一起清。

**演示前恢复出厂**（画布也回到题目本身）：

```bash
npx tsx apps/server/scripts/seed-exam-set.ts exam-set --clean
```

单题房间同理：

```bash
npx tsx apps/server/scripts/seed-problem.ts <room> --clean
```

清掉房间里的全部图元（含用户手绘和 AI 批注）后重灌，并让服务端忘掉会话。

单题那张纸默认**带着一份学生的错误作答**（用来演示"引导他自己发现错在哪"）。
想要一张只有题干和图的干净卷子，加 `--blank`：

```bash
npx tsx apps/server/scripts/seed-problem.ts <room> --clean --blank
```

> 只清画布不清会话会很怪：画面是新的，Agent 却还记得刚才讲过的整道题，
> 张口就接着上一场说。所以 `--clean` 两件事一起做。

## 辅导演练：让 Agent 当学生，把辅导跑一遍

辅导是一条来回十几轮才走得完的路。靠人肉当学生走一遍，一次十来分钟，
而且只覆盖得到自己想得起来的那几种反应——真正会出问题的
「答错之后绕不出来」「中途说不学了」「第 (2) 问被跳过」反而测不到。
所以学生也做成了 Agent：

```bash
npx tsx apps/server/scripts/seed-problem.ts drill --clean --blank
npx tsx apps/server/scripts/tutor-drill.ts --room drill --persona careless
```

它以**普通用户**的身份连进房间——同一个 WebSocket、同一套协议、同一块 Yjs 文档，
老师那边完全不知道对面是个程序。跑完打一份转录和判分，退出码 0 表示跑通。

四种人设，覆盖辅导要应付的几类学生：

| `--persona` | 这一局在测什么 |
|---|---|
| `capable` | 最顺的一条路：全程答对，走到收尾 |
| `careless`（默认） | 埋了一个典型错误，测"引导他自己发现矛盾" |
| `struggling` | 起点低、问大了就答不会，测台阶铺得够不够低 |
| `impatient` | 讲到一半喊停要答案，测**辅导中途被退出** |

判分分两类：**流程**（进没进辅导、拆没拆题、每问是否解决、每答是否有判定、
结束有没有说清楚、工具有没有真出错）决定退出码；**质量**（提问前指没指图）
只报 ⚠，不判失败——一个风格指标不该把整场演练判死。

被辅导机制主动拦下的调用（"还没判定就想提问"之类）单独计数，
那是闸门在起作用，不算故障。

## 视觉模型（可选）

没配的时候：`canvas_snapshot` 会从工具列表里**自动摘掉**——留着只会让模型反复调一个
读不出内容的工具（实测连调 5 次）。位图上标注的位置仍然算得出来
（`canvas_describe` 带 `relations` 时返回的 `onImages`），主流程不受影响。

接哪个模型：**Kimi K3** 是目前最省事的一个——原生视觉、OpenAI 兼容，
`vision.ts` 的 openai 分支正好是它要的形状，接它一行代码都不用改：

```bash
VLM_BASE_URL=https://api.moonshot.ai/v1
VLM_API_KEY=sk-xxx
VLM_MODEL=kimi-k3
```

（Kimi 文档里特别强调 `message.content` 必须是数组对象，
不能把 JSON 数组序列化成字符串——序列化了不报错，模型只当成一段普通文字，
表现是"它答得头头是道但完全没看图"。这条已经用测试钉住了。）

配好没配好，跑这个：

```bash
node scripts/check-vlm.mjs
```

### 视觉到底值不值得接：读题基准

```bash
npx tsx apps/server/scripts/vision-bench.ts --limit 5
```

它要回答的**不是**"视觉比现在准吗"——现在这条路读的是人工转录好的结构化文本，
按构造就是 100% 准，比不了。它问的是：

> **视觉能不能替掉人工转录那一步？**

能替掉，用户就可以直接拍一张作业照片扔进来。所以基准只给模型一张扫描件，
让它提取题目，拿 `problems.ts` 里 20 道题的 ground truth 对分。

四个指标里最要紧的是**数字幻觉**：提取里出现了题目根本没有的数。
辅导场景下读错一个数（把 AB=13 读成 12），后面整场推导全建在错的前提上，
而模型每一步都理直气壮——这比"读不出来"糟糕得多，因为读不出来至少会暴露。
所以打分时只要编了数，这道题直接判不过，哪怕已知量全中。

打分逻辑本身有测试（`src/__tests__/bench-score.test.ts`）——
它决定"视觉行不行"这个结论，自己错了的话给出的是一个理直气壮的错误判断。

它会依次查：能不能认证 → 模型开通了没 → 能不能读懂一张真实试卷扫描件，
最后把该填进 `.env` 的三行打出来。

### 火山方舟的坑

**「目录里有」不等于「能用」。** `GET /models` 会列出 130 个模型，但那是产品目录。
真正能调用的取决于账号有没有**开通模型服务**：

| 报错 | 含义 | 怎么办 |
|---|---|---|
| `ModelNotOpen` | 模型存在，账号没开通 | 方舟控制台 →「开通管理」→ 勾选该模型 → 开通 |
| `InvalidEndpointOrModel.NotFound` | 模型已下线，或需要用接入点 | 换新版模型，或在控制台建推理接入点后用 `ep-xxxx` 当 model |

另外，**开通 Agent Plan / 应用套餐 ≠ 开通模型推理**，这是两件事。
报错信息里会带账号号（如 `account 21xxxxxxxx`），先核对它和你开通的是不是同一个账号。
