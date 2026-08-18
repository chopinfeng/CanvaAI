# CanvaAI 架构设计

> 一块人和 AI **同时在场**的无限画布。用户画、AI 也画；用户说话、AI 也说话。
> 面向三类场景：**解题辅助**（几何/物理/数学）、**方案共创**（一起画架构图/流程图）、**共同创作**（我画房子，AI 补房顶）。

---

## 0. 一句话架构

> 画布的**场景图（scene graph）本身就是 Agent 的世界模型**。
> Agent 不"看图片"，而是**用工具查询和改写这张图**；只有在必须理解手绘笔触/位图时才降级到视觉模型。

这条原则决定了后面所有设计。它带来三个好处：

1. **精确**：AI 知道"那条线段的端点是 (120, 340)"，而不是"大概在左上角"。
2. **可逆**：AI 的每次改动都是结构化 op，可撤销、可 diff、可"建议/接受"。
3. **省 token**：不需要每轮塞整张图，Agent 按需查询（Agentic Context）。

---

## 1. 总体拓扑

```
┌─────────────────────────── Browser ───────────────────────────┐
│                                                                │
│  Canvas Layer            Voice I/O           Agent Panel       │
│  ├─ 用户图层             ├─ Mic + VAD        ├─ 对话/转写流    │
│  ├─ AI 图层 (可切换)     ├─ PCM 上行 (WS)    ├─ 工具调用可视化 │
│  ├─ 建议图层 (ghost)     └─ TTS 下行播放     └─ 建议 接受/拒绝 │
│  └─ 双光标 (user + AI)                                         │
│                                                                │
│         Yjs CRDT Doc  ◀──── awareness (光标/选区/状态)         │
└───────────────────────────────┬────────────────────────────────┘
                                │  单条 WebSocket
                                │  (多路复用: doc-sync / event / audio)
┌───────────────────────────────▼────────────────────────────────┐
│                          Server (Node/TS)                       │
│                                                                 │
│  Session Manager ── 一个 room = 一个 Doc + 一个 Agent 实例       │
│       │                                                         │
│       ├─ Yjs 权威副本 + 持久化 (SQLite/PG) + 资源存储 (S3/本地)  │
│       ├─ Event Bus  (user.draw / user.speech / ai.op / ...)     │
│       │                                                         │
│       ├─ Agent Runtime = "DeepSeek Harness"                     │
│       │    ├─ Model Client   (DeepSeek, OpenAI 兼容, 流式+FC)   │
│       │    ├─ Agent Loop     (turn / abort / interrupt)         │
│       │    ├─ Context Engine (agentic 按需取，不预填)           │
│       │    └─ Tool Registry  (canvas / geo / media / know / ...) │
│       │                                                         │
│       ├─ ASR / TTS 代理 (可插拔 provider)                        │
│       ├─ Vision 服务 (scene→SVG→PNG，喂 VLM 兜底)               │
│       └─ Sandbox (QuickJS/isolated-vm，跑 Agent 写的绘图脚本)    │
└─────────────────────────────────────────────────────────────────┘
```

**关键取舍：画布工具在服务端执行。**
Agent 调 `canvas.create_shape` → 服务端在 headless Yjs doc 上落 op → CRDT 广播到所有客户端渲染。
理由：单一权威、可无头测试（不开浏览器就能跑 Agent 端到端测试）、多端一致、Agent 循环不依赖客户端在线。

---

## 2. 文档模型（Scene Graph）

`packages/canvas-core` —— 前后端共享的纯 TS 包，无 DOM 依赖。

```ts
type ShapeId = string;               // "sh_" + nanoid

interface BaseShape {
  id: ShapeId;
  type: ShapeType;
  layer: LayerId;                    // "user" | "ai" | "suggest" | 自定义
  author: { id: string; kind: 'user' | 'ai' };
  opId: string;                      // 同一次 AI 动作共享 → 一次撤销
  x: number; y: number;              // 页面坐标（左上原点，y 向下）
  rotation: number;
  z: number;                         // 分数索引，插入不重排
  style: Style;                      // stroke/fill/width/dash/opacity/font...
  meta: Record<string, unknown>;     // 语义标注：{ role: 'roof', refs: ['sh_x'] }
  createdAt: number; updatedAt: number;
}

type ShapeType =
  | 'rect' | 'ellipse' | 'polygon' | 'line' | 'arrow' | 'path'
  | 'freedraw'                        // 手绘笔触（点序列 + 压感）
  | 'text' | 'latex'                  // latex 渲染成 SVG path，仍是矢量
  | 'image'                           // 位图/生成图，存 assetId
  | 'frame' | 'group'
  | 'plot'                            // 函数图像（参数化，可重算）
  | 'construct';                      // 几何构造对象（受约束，见 §6）
```

三条设计要点：

- **`meta.role` 是语义层**。AI 画屋顶时写 `meta = { role: 'roof', refs: ['sh_house'] }`。
  下一轮它查询画布就能知道"屋顶已经画过了、挂在哪个房子上"，不必重新看图。
- **`layer` 让 AI 的产出可整体开关**。用户一键隐藏/删除所有 AI 内容，是信任的前提。
- **`opId` 让撤销以"一次 AI 动作"为粒度**，而不是几十个 shape 一个个撤。

### 图层语义

| Layer | 谁写 | 作用 |
|---|---|---|
| `user` | 用户 | 用户自己的内容，AI **默认只读** |
| `ai` | AI | AI 的正式产出，用户可整层切换/删除 |
| `suggest` | AI | 半透明 ghost，等用户 Accept 才 promote 到 `ai` 层 |
| `annot` | AI | 批注/高亮/引导线，辅助讲解，不属于作品本体 |

> **AI 修改用户图层需要显式许可**：默认走 `suggest`。`canvas.update` 命中 `layer==='user'`
> 且会话未开启 direct 模式时，工具返回 `{ok:false, reason:'需要用户授权'}`，Agent 自动改走建议流。

---

## 3. 协同与"同时在场"

- **CRDT**：Yjs。`Y.Map<ShapeId, Y.Map>` 存 shape，`Y.Array` 存图层顺序。天然免冲突。
- **AI 的存在感**（这是产品体验的核心，不是装饰）：
  - AI 在 awareness 里有自己的 **光标 + 头像 + 状态气泡**（"正在看你的图…"/"我来补个屋顶"）。
  - `canvas.pointer_move` 是一个真工具 —— Agent 可以先把光标移过去、停一下，再落笔。
  - AI 落笔是**动画描出来的**（path 按弧长分段 tween，~600ms），不是瞬间 paste。
    实现：op 带 `anim: { kind:'draw', ms:600 }`，客户端渲染层负责补间；文档状态仍是终态。
- **打断（barge-in）**：用户开口说话或落笔 → 立刻 `abort()` 当前 agent turn（AbortSignal 贯穿模型流式请求和工具执行）→ 已落的 op 保留，未落的丢弃 → 新事件进队列。
- **等人停手才介入**：用户画完不会立刻惊动 Agent。客户端攒着这批图元，
  直到用户**彻底静止 5 秒**——鼠标移动、按键、滚动都算"还在动"——才聚合成一个 `user.draw` 推过去。

  > 判定必须包含鼠标移动。只看"有没有新图形产生"会把"正在盯着画面思考"误判成"已经画完了"，
  > AI 于是对着半成品开口，既打断思路又常常判断错。
  > 实现见 `apps/web/src/canvas/idleQueue.ts`，有独立单测覆盖时序。

  用户主动发消息时不必等：对话框会先把攒下的笔画交出去，Agent 这一回合就能同时看到
  "他画了什么"和"他说了什么"。

---

## 4. Agentic Context Engine

**反模式**：每轮把整张画布 JSON + 全部历史塞进 prompt。图一复杂就爆，且模型注意力被稀释。

**做法**：极小的常驻 header + 一组检索工具，让 Agent 自己决定看什么、看多细。

### 4.1 常驻 Context Header（每轮自动附加，约 200~400 token）

```
[画布] 1920x1080 视口 (0,0)-(1440,900) | 42 个图形 | 图层: user(31) ai(11)
[选中] sh_a3 (rect "房子主体")
[最近] 用户手绘了 3 笔 (区域 400,200-720,560)；你上一轮画了屋顶 sh_k9
[任务] 帮用户完成一幅房子简笔画 · 第 3 轮
[模式] suggest（改用户图层需先提议）
```

### 4.2 检索工具（Agent 主动调用，逐级下钻）

| 工具 | 返回 | 用途 |
|---|---|---|
| `canvas.query({type?, layer?, region?, near?, role?, limit})` | shape **摘要**列表（id/type/bbox/role，每个 ~15 token） | 先扫一眼有什么 |
| `canvas.describe({ids \| region, detail:'brief'\|'full'})` | 完整几何 + **空间关系**（相邻/包含/平行/相交/对齐） | 下钻细看 |
| `canvas.measure({a, b, what})` | 距离/夹角/面积/交点 | 精确算，不靠模型心算 |
| `canvas.snapshot({region, scale})` | 渲染 PNG → VLM 描述 → 文字 | **兜底**：手绘笔触、位图 |
| `history.search({query, k})` | 过去的对话/操作片段 | 长会话记忆 |
| `memory.get/put` | 用户偏好、术语、画风 | 跨会话 |

**渐进披露**是硬性约定：`query` 只给摘要，想要细节必须再调 `describe`。
这让上下文成本与"图的复杂度"解耦，只与"Agent 实际关心的部分"相关。

### 4.3 Vision 降级路径

DeepSeek 是纯文本模型。当 Agent 需要理解 `freedraw` 或 `image` 时：

```
canvas.snapshot(region)
  → canvas-core 序列化 SVG
  → resvg 渲染 PNG
  → VLM (Qwen-VL / GLM-4V / 任意 OpenAI 兼容 VLM) 描述
  → 文字回给 DeepSeek
```

VLM 是**可插拔的**、**按需的**、**只在必要时**。90% 的情况结构化查询就够了，且更准。

### 4.4 Prompt 前缀缓存

DeepSeek 有上下文硬盘缓存，命中前缀越长越省钱。因此消息布局必须是：

```
[ 稳定前缀 ]  system prompt · 工具定义 · 会话长期记忆      ← 一整个会话不变
[ 增量部分 ]  历史消息（append-only，不重写）
[ 易变尾部 ]  Context Header · 当轮用户事件               ← 每轮变
```

**禁止**在 system prompt 里插入画布状态——那会让缓存每轮失效。

---

## 5. Tool Registry（多且通用）

设计原则：
- **少而正交 > 多而重叠**。能用参数表达的，不开新工具。
- **每个工具都有 dry-run 语义**：写工具返回"改了什么"的结构化 diff，Agent 能自我校验。
- **失败要可恢复**：错误返回带 `hint` 字段，告诉 Agent 下一步怎么做。
- **逃生舱**：`sandbox.run` 让 Agent 写代码调 canvas API，覆盖长尾需求，避免工具数爆炸。

命名空间总览（详细 schema 见 [TOOLS.md](./TOOLS.md)）：

| 命名空间 | 工具 | 说明 |
|---|---|---|
| `canvas.read` | query, describe, measure, snapshot, hit_test, get_selection, get_viewport | §4 |
| `canvas.write` | create, update, delete, transform, style, group, align, distribute, connect, ink, erase | 结构化编辑 |
| `canvas.view` | set_viewport, zoom_to, focus, spotlight, pointer_move, highlight | **引导注意力**——讲解时的核心 |
| `canvas.layer` | create, set_visible, promote(suggest→ai), clear | 信任控制 |
| `geo` | construct(垂线/角平分线/外接圆/中点…), solve, prove_hint, plot, intersect | 几何解题 |
| `math` | evaluate, solve_symbolic, simplify, units, matrix | 走 CAS，不让模型心算 |
| `physics` | free_body, kinematics, circuit_layout | 物理题 |
| `media` | image_generate, image_edit, svg_import, mermaid_to_shapes, latex_to_shape | 位图/图表生成 |
| `knowledge` | web_search, doc_search, memory | 外部知识 |
| `interact` | say(TTS), ask_user, suggest, set_status, set_todo | 与人沟通 |
| `sandbox` | run(js) | 逃生舱：参数化/生成式绘图、批量操作 |

### 5.1 逃生舱：`sandbox.run`

```js
// Agent 生成的代码，在 QuickJS 沙箱里跑，只暴露 canvas API
const house = await canvas.get('sh_house');
const { x, y, w } = house.bbox;
canvas.create({ type: 'polygon', layer: 'ai', meta: { role: 'roof', refs: [house.id] },
  points: [[x - 20, y], [x + w / 2, y - 90], [x + w + 20, y]] });
```

一个工具覆盖"画 20 个等距的圆""按函数生成螺旋""把所有矩形对齐到网格"这类无穷长尾。
沙箱限制：无网络、无文件、CPU 50ms/次、内存 16MB、只能写 `ai`/`suggest` 层。

### 5.2 深度推理作为工具

主循环用 `deepseek-chat`（快、便宜、function calling）。
遇到硬题时调 `reason.deep({question, context})` → 内部转 `deepseek-reasoner` → 只把结论回主循环。

好处：贵模型只在该用时用；主循环的上下文不被冗长 CoT 污染。

---

## 6. 场景特化

### 解题（几何/物理）
- `construct` shape 类型带**约束**（"D 是 BC 中点"），拖动 B 时 D 自动跟随 —— 图是活的。
- 解题流程：`canvas.snapshot`/`describe` 读题 → `math.solve_symbolic` 算 → `canvas.view.focus` + `annot` 层画辅助线 → `interact.say` 逐步讲解。
- **讲解 = 视角控制 + 高亮 + 语音的编排**，`canvas.view` 那组工具是这里的主角。

### 方案共创
- `mermaid_to_shapes`：Agent 输出 mermaid，服务端转成可编辑的原生 shape（不是图片）。
- `connect` 做真正的图元绑定：移动节点，箭头自动跟随。

### 共同创作
- 关键在 `meta.role` + `refs`：AI 知道"这是房子的墙"，才画得出对的屋顶。
- 风格一致性：从用户 `freedraw` 采样笔宽/抖动/颜色，写入会话 memory，AI 用同样参数落笔。
- 位图生成（`media.image_generate`）只在用户明确要求"上色/真实感"时用；默认保持矢量简笔，跟用户笔触同构。

---

## 7. Agent Loop

```
事件入队 (user.speech.final / user.draw / user.text / user.select)
  → 是否需要唤醒 Agent? (规则 + 轻量分类)
  → 组装 messages: [稳定前缀][历史][Context Header][本轮事件]
  → stream chat.completions (tools=注册表)
      ├─ 文本 delta      → 推前端 + 增量 TTS
      ├─ tool_calls      → 并行执行 → observation 回灌 → 继续循环
      └─ finish          → 结束 turn
  → 任一时刻 AbortSignal 触发 → 停流、停工具、保留已落 op
```

约束：单 turn 最多 N 步工具（默认 12）、最长 60s、总 token 预算上限；超限则 `interact.say` 汇报进度并让出。

---

## 8. 语音链路

```
Mic → AudioWorklet (16k mono PCM) → VAD → WS(binary) → ASR(流式)
   → partial 转写实时上屏 → final 进事件队列
Agent interact.say(text) → TTS(流式) → WS → WebAudio 播放
用户开口 → 立即停 TTS + abort turn（barge-in）
```

ASR/TTS 全部走 `packages/agent/providers/*` 的统一接口，可换 provider（本地 whisper.cpp / FunASR / 云厂商）。

---

## 9. 仓库结构

```
CanvaAI/
├─ apps/
│  ├─ web/                 React + Vite + TS，画布与语音 UI
│  └─ server/              Fastify + ws，会话/同步/Agent 宿主
├─ packages/
│  ├─ protocol/            zod schema：事件、工具 IO（前后端唯一真相）
│  ├─ canvas-core/         场景模型、几何运算、SVG 序列化（同构，无 DOM）
│  ├─ agent/               DeepSeek Harness：model client / loop / context / tools
│  └─ ui/                  共享组件
└─ docs/                   本文档 + TOOLS.md + ROADMAP.md
```

`protocol` 用 zod 定义一次，同时产出 TS 类型和给模型的 JSON Schema —— 工具定义不会和实现漂移。

---

## 10. 已知风险与对策

| 风险 | 对策 |
|---|---|
| AI 乱改用户内容 | `suggest` 层 + 图层权限 + `opId` 整体撤销 |
| 延迟毁掉"同时在场"感 | 乐观渲染、`pointer_move` 先行、状态气泡、动画描线掩盖思考时间 |
| 上下文爆炸 | 渐进披露、摘要优先、前缀缓存 |
| DeepSeek 无视觉 | 结构化场景为主，VLM 按需兜底 |
| 工具调用出错循环 | 每个错误带 `hint`；连续 3 次同类失败 → 强制 `ask_user` |
| 沙箱逃逸 | QuickJS-wasm，无网络/文件，CPU 与内存硬限 |
