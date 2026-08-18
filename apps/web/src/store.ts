import { create } from 'zustand';
import type { LayerId, Rect, Shape, ToolCallView } from '@canvai/protocol';

export type Tool = 'select' | 'pen' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text' | 'eraser';

/**
 * 模型在一个回合里的一步。
 *
 * hadTools===true  这一步是"边想边调工具"，正文属于内部推理 → 折进思考轨迹
 * hadTools===false 这一步没再调工具，正文就是最终答复 → 作为气泡展示
 * hadTools===null  这一步还在流式输出，先按推理显示
 */
export interface Step {
  text: string;
  hadTools: boolean | null;
}

export interface ChatEntry {
  id: string;
  role: 'user' | 'ai';
  text: string;
  steps?: Step[];
  /** AI 消息还在流式输出中 */
  streaming?: boolean;
  tools?: ToolCallView[];
}

/** 折进思考轨迹的部分 */
export const thinkingOf = (e: ChatEntry): string =>
  (e.steps ?? [])
    .filter((s) => s.hadTools !== false)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n\n');

/** 真正当作答复展示的部分 */
export const answerOf = (e: ChatEntry): string =>
  e.text || (e.steps ?? []).find((s) => s.hadTools === false)?.text.trim() || '';

export interface Suggestion {
  opId: string;
  summary: string;
  shapeIds: string[];
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

interface State {
  /* 连接 */
  status: 'connecting' | 'open' | 'closed';

  /* 画布 */
  shapes: Shape[];
  camera: Camera;
  tool: Tool;
  strokeColor: string;
  strokeWidth: number;
  selection: string[];
  layerVisible: Record<LayerId, boolean>;

  /* AI 在场 */
  aiPointer: { x: number; y: number; ms: number } | null;
  aiStatus: string;
  spotlight: { ids: string[]; dim: number } | null;
  highlights: Record<string, 'glow' | 'outline' | 'pulse'>;

  /* 对话 */
  chat: ChatEntry[];
  todos: Array<{ text: string; done: boolean }>;
  suggestions: Suggestion[];
  ask: { askId: string; question: string; options?: string[] } | null;
  turnRunning: boolean;
  /** 画了东西但用户还在动，Agent 在等他停手 */
  awaitingIdle: boolean;
  /** 页面是否在前台且有焦点。不在前台时 Agent 不动手，界面要说清楚原因 */
  foreground: boolean;
  /** 辅导模式：AI 一步步引导，不直接给答案 */
  tutorMode: boolean;
  /** 由画布层注入：不等了，立刻把攒下的笔画交给 Agent */
  flushDraws: (() => void) | null;
  /** 撤销/重做栈深度，决定按钮能不能点 */
  undoDepth: number;
  redoDepth: number;
  /** 由画布层注入 */
  undo: (() => void) | null;
  redo: (() => void) | null;

  /* 动作 */
  set: (patch: Partial<State>) => void;
  setCamera: (patch: Partial<Camera>) => void;
  pushChat: (entry: ChatEntry) => void;
  appendAiText: (turnId: string, step: number, delta: string) => void;
  resolveStep: (turnId: string, step: number, hadTools: boolean) => void;
  upsertToolCall: (turnId: string, call: ToolCallView) => void;
  endTurn: (turnId: string) => void;
  toggleLayer: (layer: LayerId) => void;
  clearHighlight: (id: string) => void;
  removeSuggestion: (opId: string) => void;
}

export const useStore = create<State>((set) => ({
  status: 'connecting',

  shapes: [],
  camera: { x: 0, y: 0, zoom: 1 },
  tool: 'pen',
  strokeColor: '#111827',
  strokeWidth: 3,
  selection: [],
  layerVisible: { user: true, ai: true, annot: true, suggest: true },

  aiPointer: null,
  aiStatus: '',
  spotlight: null,
  highlights: {},

  chat: [],
  todos: [],
  suggestions: [],
  ask: null,
  turnRunning: false,
  awaitingIdle: false,
  foreground: true,
  tutorMode: false,
  flushDraws: null,
  undoDepth: 0,
  redoDepth: 0,
  undo: null,
  redo: null,

  set: (patch) => set(patch),
  setCamera: (patch) => set((s) => ({ camera: { ...s.camera, ...patch } })),

  pushChat: (entry) => set((s) => ({ chat: [...s.chat, entry] })),

  /** 流式文本按 step 落到当前 turn 的那条 AI 消息上，没有就新建 */
  appendAiText: (turnId, step, delta) =>
    set((s) => {
      const idx = s.chat.findIndex((c) => c.id === turnId);
      const base: ChatEntry =
        idx === -1 ? { id: turnId, role: 'ai', text: '', streaming: true, steps: [], tools: [] } : s.chat[idx]!;

      const steps = [...(base.steps ?? [])];
      while (steps.length <= step) steps.push({ text: '', hadTools: null });
      steps[step] = { ...steps[step]!, text: steps[step]!.text + delta };

      const entry = { ...base, steps };
      if (idx === -1) return { chat: [...s.chat, entry] };
      const next = [...s.chat];
      next[idx] = entry;
      return { chat: next };
    }),

  /** 一步收尾：知道它是推理还是答复了 */
  resolveStep: (turnId, step, hadTools) =>
    set((s) => {
      const idx = s.chat.findIndex((c) => c.id === turnId);
      if (idx === -1) return {};
      const entry = s.chat[idx]!;
      const steps = [...(entry.steps ?? [])];
      while (steps.length <= step) steps.push({ text: '', hadTools: null });
      steps[step] = { ...steps[step]!, hadTools };
      const next = [...s.chat];
      next[idx] = { ...entry, steps };
      return { chat: next };
    }),

  upsertToolCall: (turnId, call) =>
    set((s) => {
      const idx = s.chat.findIndex((c) => c.id === turnId);
      const base: ChatEntry =
        idx === -1 ? { id: turnId, role: 'ai', text: '', streaming: true, steps: [], tools: [] } : s.chat[idx]!;
      const tools = [...(base.tools ?? [])];
      const ti = tools.findIndex((t) => t.id === call.id);
      if (ti === -1) tools.push(call);
      else tools[ti] = { ...tools[ti]!, ...call };

      const entry = { ...base, tools };
      if (idx === -1) return { chat: [...s.chat, entry] };
      const next = [...s.chat];
      next[idx] = entry;
      return { chat: next };
    }),

  endTurn: (turnId) =>
    set((s) => ({
      turnRunning: false,
      aiStatus: '',
      chat: s.chat.map((c) => (c.id === turnId ? { ...c, streaming: false } : c)),
    })),

  toggleLayer: (layer) =>
    set((s) => ({ layerVisible: { ...s.layerVisible, [layer]: !s.layerVisible[layer] } })),

  clearHighlight: (id) =>
    set((s) => {
      const next = { ...s.highlights };
      delete next[id];
      return { highlights: next };
    }),

  removeSuggestion: (opId) => set((s) => ({ suggestions: s.suggestions.filter((x) => x.opId !== opId) })),
}));

/**
 * 开发期把 store 挂到 window 上。
 * 画布状态大半在 canvas 里，DevTools 点不进去；有这个入口才能在控制台里
 * 直接看当前图元、选区、Agent 是不是在等停手。生产构建不包含这段。
 */
if (import.meta.env.DEV) {
  (globalThis as unknown as { __canvai?: unknown }).__canvai = { store: useStore };
}

/** 屏幕坐标 → 画布坐标 */
export const toCanvas = (p: { x: number; y: number }, cam: Camera) => ({
  x: (p.x - cam.x) / cam.zoom,
  y: (p.y - cam.y) / cam.zoom,
});

/** 当前视口在画布坐标系里的矩形 */
export const viewportRect = (cam: Camera, w: number, h: number): Rect => [
  -cam.x / cam.zoom,
  -cam.y / cam.zoom,
  w / cam.zoom,
  h / cam.zoom,
];
