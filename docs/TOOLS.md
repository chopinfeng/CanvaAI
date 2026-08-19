# Tool Registry 规格

所有工具在 `packages/protocol/src/tools/*.ts` 用 zod 定义，`zodToJsonSchema` 产出模型侧 schema。
**定义与实现同源，不会漂移。**

## 通用约定

```ts
// 统一返回信封
type ToolResult<T> =
  | { ok: true;  data: T;  diff?: SceneDiff }        // diff 让 Agent 自检改了什么
  | { ok: false; error: string; hint: string };       // hint 必填：告诉 Agent 下一步怎么办
```

- **坐标**：页面坐标系，左上原点，y 向下，单位 px。**对外只有绝对坐标一种写法**：
  - 有 `points` 的图元（line/arrow/polygon/path/freedraw）——`points` 写绝对坐标，**不填 x/y**
  - 无 `points` 的图元（rect/ellipse/text/image）——`x`/`y` 定左上角，配 `w`/`h`

  > 内部存储仍是「原点 + 相对点」（拖动只改 x/y，不必重写点序列），换算在工具边界完成。
  > 早先把这个不变式暴露给模型，它会既给绝对 `points` 又顺手填 `x`/`y`，偏移叠加两次，
  > 图形直接飞出画布。约定收窄成单一写法后这类错误消失。
- **颜色**：`#RRGGBB` 或语义色 `primary|accent|muted|error`。
- **写工具默认落 `ai` 层**；写 `user` 层需 `force:true` 且会话为 direct 模式，否则报错并提示改用 `interact.suggest`。
- **批量优先**：写工具都接受数组，一次调用 = 一个 `opId` = 一次撤销。

---

## canvas.read

```ts
canvas.query({
  type?: ShapeType[]; layer?: LayerId[]; role?: string[];
  region?: [x, y, w, h];            // 与该矩形相交
  near?: { id: ShapeId; within: number };
  limit?: number;                    // 默认 30
}) -> { shapes: ShapeBrief[]; total: number; truncated: boolean }
// ShapeBrief = { id, type, layer, role?, bbox, text? }  ≈15 token/个

canvas.describe({
  ids?: ShapeId[]; region?: Rect;
  detail: 'brief' | 'full';
  relations?: boolean;               // 附带空间关系
}) -> {
  shapes: Shape[];
  relations?: Array<{ a, b, kind: 'contains'|'touches'|'parallel'|'perpendicular'
                                 |'intersects'|'aligned-x'|'aligned-y'; value?: number }>;
}

canvas.measure({ a: Ref; b?: Ref; what: 'distance'|'angle'|'area'|'length'|'intersection'|'bbox' })
// Ref = ShapeId | Point | { id, anchor: 'center'|'start'|'end'|'v0'.. }

canvas.snapshot({ region?: Rect; scale?: number; describe?: boolean })
  -> { assetId, width, height, description? }   // describe:true 时走 VLM

canvas.hit_test({ point: Point; radius?: number }) -> { shapes: ShapeBrief[] }
canvas.get_selection() -> { ids: ShapeId[] }
canvas.get_viewport()  -> { x, y, w, h, zoom }
```

## canvas.write

```ts
canvas.create({ shapes: ShapeInput[]; layer?: LayerId; anim?: AnimSpec })
  -> { ids: ShapeId[]; opId: string }

canvas.update({ patches: Array<{ id; set: Partial<Shape> }> })
canvas.delete({ ids: ShapeId[] })
canvas.transform({ ids; translate?; scale?; rotate?; origin? })
canvas.style({ ids; style: Partial<Style> })
canvas.group({ ids; name? }) / canvas.ungroup({ id })
canvas.align({ ids; axis: 'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom' })
canvas.distribute({ ids; axis: 'x'|'y'; gap? })
canvas.connect({ from: Ref; to: Ref; kind: 'arrow'|'line'; label?; routing?: 'straight'|'ortho'|'curve' })
  // 真正的绑定：两端 shape 移动时箭头自动重算
canvas.ink({ points: [x,y,pressure?][]; smooth?: boolean; style? })  // 模拟手绘笔触
canvas.erase({ region: Rect; layer?: LayerId })
```

## canvas.view — 讲解的主角

> **不要靠压暗别处来突出重点。** `canvas.spotlight` 早先是真的"聚光"：
> 把没点名的图元整体降透明度。实测讲题时更糟——学生要同时看清标出来的那条边
> **和它周围的图**，周围一暗参照物就没了，等于把整张图变模糊。
> 现在它和 `canvas.highlight(ms:0)` 一样只是"一直标着"，别处一点不动；
> 标出来的部分做呼吸动画（`apps/web/src/canvas/pulse.ts`），
> 动的东西人眼自己会追过去，这是免费的注意力。
> 全局只跑一条 rAF，所有高亮同步起伏——各跑各的会看上去像在抖。

```ts
canvas.set_viewport({ x, y, zoom, animate?: boolean })
canvas.zoom_to({ ids?: ShapeId[]; region?: Rect; padding? })
canvas.focus({ ids })                       // 居中 + 轻微放大
canvas.spotlight({ ids; dim?: number })     // 其余内容压暗，讲解神器
canvas.highlight({ ids; kind: 'glow'|'outline'|'pulse'; ms? })
canvas.pointer_move({ to: Point | ShapeId; ms?: number })  // AI 光标移动，制造"在场感"
```

## canvas.layer

```ts
canvas.layer.create({ id; name; opacity? })
canvas.layer.set_visible({ id; visible })
canvas.layer.promote({ opId })    // suggest → ai，用户接受后调用
canvas.layer.clear({ id })
```

## geo — 几何构造（带约束，可拖动）

```ts
geo.construct({
  kind: 'midpoint'|'perpendicular'|'parallel'|'bisector'|'circumcircle'|'incircle'
      | 'tangent'|'reflect'|'rotate_about'|'intersection'|'extend',
  args: Ref[]; label?: string; layer?: 'annot';
}) -> { id; description }        // 约束记录在 shape 上，父对象移动时自动重算

geo.solve({ given: string[]; find: string; figure?: ShapeId[] })
  -> { answer; steps: string[]; construction?: ConstructionStep[] }
      // construction 可直接喂给 canvas.create 把辅助线画出来

geo.plot({ expr: string; range: [min,max]; var?: string; region?: Rect })
```

## math / physics

```ts
math.evaluate({ expr, vars? })
math.solve_symbolic({ equations: string[]; for: string[] })   // 走 CAS，不让模型心算
math.simplify({ expr }) / math.units({ value, from, to }) / math.matrix({ op, a, b? })

physics.free_body({ object: string; forces: Force[] })  -> 受力图 shapes
physics.kinematics({ given, find })
physics.circuit_layout({ netlist })                      -> 电路图 shapes
```

## media

```ts
media.image_generate({ prompt; size?; region?; style?: 'sketch'|'flat'|'realistic' })
media.image_edit({ assetId; prompt; mask? })
media.svg_import({ svg: string; at: Point; scale? })      // 解析为原生 shape，可编辑
media.mermaid_to_shapes({ code: string; at: Point })      // 输出可编辑图元，不是图片
media.latex_to_shape({ tex: string; at: Point; display? })
```

## knowledge

```ts
knowledge.web_search({ query; k? })
knowledge.doc_search({ query; k? })                       // 会话上传的资料 RAG
knowledge.memory.get({ query?; scope: 'session'|'user' })
knowledge.memory.put({ key; value; scope })               // 画风偏好、术语、习惯
```

## interact

```ts
interact.say({ text; tone?: 'neutral'|'encouraging'|'excited'; interruptible?: boolean })
interact.ask_user({ question; options?: string[] })       // 阻塞本 turn，等用户回答
interact.suggest({ opId; summary })                       // 把 suggest 层的改动提交给用户确认
interact.set_status({ text })                             // "正在看你的图…" 气泡
interact.set_todo({ items: Array<{ text; done }> })        // 长任务的进度可视化
```

## tutor —— 一次辅导的账本

```ts
tutor.plan({ items: Array<{ text; done }> })          // 拆题 / 更新进度，每次传全量清单
tutor.judge({ verdict: 'right'|'partly'|'wrong'; comment })  // 判他刚才那次回答
tutor.finish({ summary })                             // 收尾并切回普通模式；账没平会被拒绝
```

只在辅导模式下有意义。存在的理由是一个具体的失败：
模型讲完第 (1) 问、用户说声"懂了"，它就顺势宣布讲完了——第 (2) 问再没人提起，
模式也一直挂在辅导上下不来。所以把"这次要讲到哪儿为止"从模型的印象里
挪到会话状态（`SessionState.tutor`）上，机制上保证：

- **清单每一轮都写进 Context Header**，模型赖不掉；
- `tutor.finish` 在还有未完成项时**直接报错**，并列出剩下哪些；
- **答完必须表态**：手上压着一次没判定的回答，`interact.ask_user` 会被拒。
  只被一路追问、从不知道自己刚才那步是对是错，答十道题也没长进；
- **打勾要有门票**：一个小问要标成 done，得先有一次 `tutor.judge` 判 `right`。
  只挡开局那一次不够——实测模型会在同一轮里连调两次 `tutor.plan`，
  第一次老实拆题，第二次就把第 (1) 问打上勾，用户还一个字都没答；
- 一轮结束时如果既没提问、账又没平，主循环会**拦回来**补一次
  （见 `AgentLoop.tutorHandBack`）——球断在中间就是辅导散掉的样子。

**停手一定要说一声。** 题没讲完就停下来是允许的（超时、报错、模型自己不问了），
不允许的是一声不吭地停——用户等在那儿，不知道该答什么，也不知道是不是结束了。
`AgentLoop.announceTutorPause` 在回合出口兜底说这句话（"先停在这里，还剩 N 个，
卡在……"），不依赖模型配合；真讲完了由 `tutor.finish` 明说"到此结束"。

两个和辅导直接相关的额度修正，都出自同一个观察——
**`interact.ask_user` 会阻塞回合，所以一整场辅导是「一个回合」**：

- 回合时限只算 Agent 自己干活的时间。挂钟计时的话，学生盯着几何题想两分钟，
  回合就超时死了，问题还挂在屏幕上，谁也没说一句话。
- 步数上限在用户每次开口后重新起算。它是防死循环的，不是给辅导设的课时——
  问一次、判一次、再问一次，十来步就撞上限被掐断（实测就是这么被掐的）。
  用户开口过就说明这不是空转。

想提前走只有一条路：用户自己说要走（要答案、或者去做别的），
由 `detectTutorIntent` 识别后切模式。这条判断在**聊天框和答题框都生效**：
辅导时 Agent 大部分时间停在 `interact.ask_user` 上，那句"先不学了"多半打在答题框里。

## sandbox

```ts
sandbox.run({ code: string; timeoutMs?: number })
  -> { ok; logs: string[]; created: ShapeId[]; error? }
```

沙箱内可用 API：`canvas.get/query/create/update/delete/measure`、`Math`、`JSON`。
禁止：网络、文件、`eval`、写 `user` 层。限制：CPU 50ms、内存 16MB。

---

## 工具设计红线

1. **不要为"画矩形"和"画圆"开两个工具** —— `canvas.create` 一个，type 参数区分。
2. **不要返回裸数组** —— 永远用 `ToolResult` 信封，失败必带 `hint`。
3. **不要让模型算数** —— 距离、角度、方程一律走 `canvas.measure` / `math.*`。
4. **不要把整个场景塞进任何一个返回值** —— `query` 有 `limit` 和 `truncated`。
5. **新需求先问"能不能用 `sandbox.run` 搞定"** —— 能就不加工具。
