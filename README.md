# CanvaAI

一块人和 AI **同时在场**的无限画布。你画，AI 也画；你说话，AI 也说话。

- **辅助解题** —— 几何、物理、数学：AI 画辅助线、聚光讲解，而不是甩一段文字解析
- **方案共创** —— 一起画架构图、流程图，连线自动绑定，移动节点箭头跟着走
- **一起画画** —— 你画个房子，AI 补上房顶，笔触风格跟着你走

核心设计：**画布的场景图就是 Agent 的世界模型**。AI 不"看图片"，而是用工具查询和改写这张图。
详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 快速开始

```bash
pnpm install
```

```bash
cp .env.example .env
```

在 `.env` 里填上 `DEEPSEEK_API_KEY`（没有也能跑，画布和多端协同正常，只是 AI 不响应）。

启动服务端和前端：

```bash
pnpm dev
```

打开 http://localhost:5173 。开两个标签页可以看到实时协同。

### 试试看

1. 用矩形工具画一个方块
2. 在右侧输入「在这个方块上面加个屋顶」
3. AI 的光标会先移过去，然后把三角形一笔一笔描出来

---

## 当前进度

| 里程碑 | 状态 |
|---|---|
| M0 骨架 | ✅ |
| M1 画布内核（场景模型 / 几何 / Konva 渲染 / CRDT 协同） | ✅ |
| M2 Agent 闭环（DeepSeek Harness / 29 个工具 / 无头 E2E） | ✅ |
| M3 Agentic Context 铺开（VLM 兜底 / sandbox / 几何构造 / 提案交互） | 部分 |
| M4 语音全双工 | 未开始 |

95 个测试覆盖几何运算、CRDT 并发、工具权限、坐标约定、错误恢复、打断、上下文布局、快照持久化（含损坏快照不被覆盖）、原生渲染崩溃隔离、停手判定、模型参数怪癖、辅导模式约束、图片资源。

```bash
pnpm test
```

---

## 结构

```
apps/
  web/          React + Vite + Konva，画布与对话 UI
  server/       Node + ws，会话管理 / Yjs 权威副本 / Agent 宿主
packages/
  protocol/     zod schema：图元、事件、工具 IO —— 前后端与模型侧的唯一真相
  canvas-core/  场景模型、几何运算、SVG 序列化（同构，无 DOM 依赖）
  agent/        DeepSeek Harness：模型客户端 / Agent Loop / Context Engine / 工具实现
docs/
  ARCHITECTURE.md   架构设计
  TOOLS.md          工具注册表规格
  ROADMAP.md        实施路线
  OPERATIONS.md     日志与排查
  PROBLEM-SETS.md   题目导入与转换核对
```

## 把真题灌进画布

从试卷 PDF 按题裁出原图、转录题干，左右并排放进画布——**转换对不对，对着原件看一眼就知道**：

```bash
cd apps/server && npx tsx scripts/seed-exam-set.ts exam-set
```

已内置 20 道中考真题。详见 [docs/PROBLEM-SETS.md](docs/PROBLEM-SETS.md)。

## 出问题时

服务端日志在 `logs/server-<日期>.jsonl`，崩溃现场单独存成 `.crash-*.jsonl`（出事前最近 300 条事件）。
`curl -s localhost:3001/health` 会直接告诉你当前日志路径。

前端看到 `ECONNREFUSED` 刷屏基本都是**服务端进程已经死了**，vite 的报错只是转发失败的表象——
真正的原因去 `logs/` 里找。详见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

---

## 几个值得知道的设计点

**图层就是权限边界。** `user` 层是用户的作品，AI 默认改不了；要改必须画在 `suggest` 层等用户点接受。
AI 自己的产出全在 `ai` 层，用户可以一键整层隐藏或删除。

**一次动作 = 一个 opId = 一次撤销。** AI 画一座房子产生十几个图元，用户按一次 Cmd+Z 就全没了，
而不是按十几次。

**上下文是取来的，不是塞进去的。** 每轮只带 200~400 token 的画布概况，
Agent 想知道细节自己调 `canvas_query` → `canvas_describe` 逐级下钻。图再复杂，上下文也不跟着膨胀。

**system prompt 逐字不变。** 画布状态一律放在消息序列末尾，保住 DeepSeek 的前缀缓存。
服务端日志会打印每轮的缓存命中率。

**AI 等你真的停手才介入。** 判定"停手"把**鼠标移动**也算进去——手还在画布上游移说明人还在想，
这时候插进来既打断思路，也容易对着半成品下判断。停够 5 秒才动，期间画的内容攒成一批一起交给它。
页面切到后台或窗口失去焦点时同样不动手——人没在看，画布不该自己变样；切回来重新计时，
不会一进来就看到 AI 正在改你的图。你主动开口时不用等，攒下的笔画会跟着消息一并送出。

**辅导模式下 AI 不给答案。** 面板右上角的「辅导」开关打开后，它每轮只推进一步：
在图上标出该看的东西 → 提一个具体问题 → 停下来等你回答。你答错了它也不直接纠正，
而是反问一个能让你自己看出矛盾的问题。约束写在 `TUTOR_ADDENDUM` 里，有测试锁住。

**AI 落笔是描出来的。** 光标先移过去，路径按弧长逐段显现。文档里存的是终态，动画只在渲染层。
这几百毫秒是"有人在跟你一起画"和"系统生成了一张图"的区别。

**只有 `interact_say` 会传到用户耳朵里。** 模型在工具调用之间写的正文是内部推理，
折进可展开的「思考过程」，不冒充说话。这让它可以放心地在正文里推演，
而用户看到的始终是干净的一两句结论。

**对模型只暴露绝对坐标。** 内部存的是「原点 + 相对点」（拖动只改 x/y），
但换算在工具边界完成——把这个不变式交给模型维护，它会给出双重偏移的图形。

---

## 无头测试 Agent 行为

`packages/agent/src/__tests__/harness.ts` 提供脚本化模型：把"模型这一步调什么工具"写死，
断言产生的场景变化。不联网、不花钱、毫秒级。

```ts
const h = makeHarness([
  { calls: [call('canvas_query', { limit: 30 })] },
  { calls: [call('canvas_create', { shapes: [{ type: 'polygon', /* ... */ }] })] },
]);
h.loop.push({ kind: 'text', text: '加个屋顶', at: Date.now() });
await h.loop.drain();
expect(h.scene.all().find((s) => s.meta.role === 'roof')?.layer).toBe('ai');
```

## 没有 API key 时验证整条链路

`scripts/mock-deepseek.mjs` 是一个 DeepSeek 兼容的假端点，会分片下发 tool_calls，
用来验证 SSE 解析、工具调用拼装、CRDT 广播、落笔动画：

```bash
node scripts/mock-deepseek.mjs
```

```bash
DEEPSEEK_API_KEY=fake DEEPSEEK_BASE_URL=http://127.0.0.1:8899 pnpm --filter @canvai/server dev
```
