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

- **坐标**：页面坐标系，左上原点，y 向下，单位 px。
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
