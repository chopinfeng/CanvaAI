# 实施路线

原则：**每个里程碑都是一个能跑起来、能看见效果的完整纵切**，不是"先写完所有底层再联调"。

---

## M0 — 骨架（半天）

- pnpm monorepo：`apps/web`、`apps/server`、`packages/{protocol,canvas-core,agent}`
- TS 严格模式、vitest、eslint、`.env.example`
- 一条 WebSocket 打通：浏览器画一笔 → 服务端收到 → 广播回另一个标签页

**验收**：两个浏览器标签页，一边画，另一边同步出现。

---

## M1 — 画布内核（1~2 天）

- `canvas-core`：shape 模型、Yjs 绑定、几何运算（bbox/相交/距离/夹角）、SVG 序列化
- `apps/web` 渲染层：矢量渲染、手绘笔触（perfect-freehand）、选择/拖拽/缩放、无限画布
- 图层系统 + 双光标 + awareness

**验收**：能手绘、能画基本图形、能多端同步、能看到对方光标。

---

## M2 — Agent 最小闭环（2 天）★ 关键里程碑

- `packages/agent`：DeepSeek client（流式 + function calling）、Agent Loop、Context Header
- 首批工具：`canvas.query` / `describe` / `create` / `update` / `delete` / `view.focus` / `interact.say`
- 前端 Agent 面板：对话流 + 工具调用可视化
- **无头 E2E 测试**：给定场景 + 指令，断言产生的 op —— 不开浏览器就能回归 Agent 行为

**验收**：文字输入"在这个矩形上面画个三角形当屋顶" → AI 光标移过去 → 动画描出三角形。

---

## M3 — Agentic Context + 工具铺开（2~3 天）

- 渐进披露完整实现、`measure`、`snapshot` + VLM 兜底
- `canvas.view` 全组（spotlight / highlight / pointer_move）
- `sandbox.run`（QuickJS-wasm）
- `math.*` + `geo.construct`
- `suggest` 层 + Accept/Reject 交互
- 前缀缓存优化（验证 cache hit 率）

**验收**：贴一道几何题截图 → AI 读题、画辅助线、聚光讲解、给出解答。

---

## M4 — 语音全双工（2 天）

- AudioWorklet 采集 + VAD、流式 ASR、流式 TTS、barge-in
- 语音事件与画布事件统一进 Agent 事件队列

**验收**：边画边说"这里再加个窗户"，AI 一边应答一边落笔；说话时能打断 AI。

---

## M5 — 场景打磨（持续）

- 解题：约束几何、物理受力图、分步讲解编排
- 共创：画风采样、`meta.role` 语义、`media.image_generate`
- 方案：`mermaid_to_shapes`、`connect` 绑定路由
- 持久化、会话恢复、导出（PNG/SVG/PDF）

---

## 技术选型（已定稿）

| 项 | 选择 | 理由 |
|---|---|---|
| 画布引擎 | **自建 canvas-core + Konva 渲染** | 场景模型完全自定义，`meta.role`、约束、`opId`、图层权限都能挂在图元上；MIT 依赖无商用许可风险；同构、可无头测试 |
| 语音 | **服务端流式 ASR/TTS，provider 可插拔** | 中文识别质量与 barge-in 控制都优于浏览器 API；接口统一，换厂商不动上层 |
| 后端 | **Node/TS 全栈 + Python 数学 sidecar** | protocol / canvas-core 前后端共享类型；`math.solve_symbolic`、`geo.solve` 走 SymPy |

## 已完成（2026-08-17）

- M0 骨架、M1 画布内核、M2 Agent 闭环全部跑通
- 46 个测试：几何运算、CRDT 并发合并、工具权限、错误恢复、打断、上下文布局
- 端到端验证：文字指令 → SSE 分片 tool_calls 拼装 → 服务端执行 → CRDT 广播 → 浏览器落笔动画

## 下一步

1. `sandbox.run`（QuickJS-wasm）—— 覆盖长尾绘图需求的逃生舱
2. Python 数学 sidecar + `geo.construct` 约束几何
3. UndoManager 按 `opId` 分组
4. M4 语音全双工
