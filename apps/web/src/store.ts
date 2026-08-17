import { create } from 'zustand';
import type { LayerId, Rect, Shape, ToolCallView } from '@canvai/protocol';

export type Tool = 'select' | 'pen' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text' | 'eraser';

export interface ChatEntry {
  id: string;
  role: 'user' | 'ai';
  text: string;
  /** AI 消息还在流式输出中 */
  streaming?: boolean;
  tools?: ToolCallView[];
}

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

  /* 动作 */
  set: (patch: Partial<State>) => void;
  setCamera: (patch: Partial<Camera>) => void;
  pushChat: (entry: ChatEntry) => void;
  appendAiText: (turnId: string, delta: string) => void;
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

  set: (patch) => set(patch),
  setCamera: (patch) => set((s) => ({ camera: { ...s.camera, ...patch } })),

  pushChat: (entry) => set((s) => ({ chat: [...s.chat, entry] })),

  /** 流式文本落到当前 turn 的那条 AI 消息上，没有就新建 */
  appendAiText: (turnId, delta) =>
    set((s) => {
      const idx = s.chat.findIndex((c) => c.id === turnId);
      if (idx === -1) {
        return { chat: [...s.chat, { id: turnId, role: 'ai' as const, text: delta, streaming: true }] };
      }
      const next = [...s.chat];
      next[idx] = { ...next[idx]!, text: next[idx]!.text + delta };
      return { chat: next };
    }),

  upsertToolCall: (turnId, call) =>
    set((s) => {
      const idx = s.chat.findIndex((c) => c.id === turnId);
      const base: ChatEntry =
        idx === -1 ? { id: turnId, role: 'ai', text: '', streaming: true, tools: [] } : s.chat[idx]!;
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
