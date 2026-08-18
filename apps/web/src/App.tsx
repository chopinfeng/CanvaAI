import { useEffect, useMemo, useRef } from 'react';
import { nanoid } from 'nanoid';
import type { Author, ServerMessage } from '@canvai/protocol';
import { AgentPanel } from './ui/AgentPanel';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Toolbar } from './ui/Toolbar';
import { CanvasStage } from './canvas/CanvasStage';
import { Connection } from './net/connection';
import { useStore } from './store';

const COLORS = ['#2563eb', '#059669', '#dc2626', '#d97706', '#7c3aed'];

function makeMe(): Author & { color: string } {
  const stored = localStorage.getItem('canvai.me');
  if (stored) return JSON.parse(stored) as Author & { color: string };
  const me = {
    id: `u_${nanoid(6)}`,
    kind: 'user' as const,
    name: '我',
    color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
  };
  localStorage.setItem('canvai.me', JSON.stringify(me));
  return me;
}

export function App() {
  const me = useMemo(makeMe, []);
  const roomId = useMemo(() => new URLSearchParams(location.search).get('room') ?? 'default', []);
  const set = useStore((s) => s.set);
  const connRef = useRef<Connection | null>(null);

  const conn = useMemo(() => {
    const c = new Connection({
      roomId,
      user: { id: me.id, name: me.name ?? '我', color: me.color },
      onStatusChange: (status) => set({ status }),
      onControl: (msg) => handleControl(msg),
    });
    connRef.current = c;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  /* ---------------------------------------------------------------- *
   * 场景 → store
   *
   * 任何来源（本地、远端、AI）的文档变化都在这里收敛成一次 setState。
   * 渲染层不关心改动是谁做的，只关心当前场景长什么样。
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const sync = () => set({ shapes: conn.scene.all() });
    const off = conn.scene.onChange(sync);
    sync();
    conn.connect();
    return () => {
      off();
      conn.disconnect();
    };
  }, [conn, set]);

  /* ---------------------------------------------------------------- *
   * 服务端控制消息
   * ---------------------------------------------------------------- */

  function handleControl(msg: ServerMessage): void {
    const s = useStore.getState();

    switch (msg.t) {
      case 'joined':
        set({ status: 'open', tutorMode: msg.mode === 'tutor' });
        break;

      case 'agent.turn.start':
        set({ turnRunning: true });
        s.pushChat({ id: msg.turnId, role: 'ai', text: '', streaming: true, steps: [], tools: [] });
        break;

      case 'agent.text':
        s.appendAiText(msg.turnId, msg.step, msg.delta);
        break;

      case 'agent.step':
        s.resolveStep(msg.turnId, msg.step, msg.hadTools);
        break;

      case 'agent.tool':
        s.upsertToolCall(msg.turnId, msg.call);
        break;

      case 'agent.turn.end':
        s.endTurn(msg.turnId);
        break;

      case 'agent.status':
        set({ aiStatus: msg.text });
        break;

      case 'agent.todo':
        set({ todos: msg.items });
        break;

      case 'agent.pointer':
        set({ aiPointer: { x: msg.to.x, y: msg.to.y, ms: msg.ms } });
        break;

      case 'agent.viewport': {
        // AI 把用户的视线带过去：算出让该区域居中的相机参数
        if (!msg.rect) break;
        const [x, y, w, h] = msg.rect;
        const zoom = Math.max(0.1, Math.min(3, Math.min(window.innerWidth / w, window.innerHeight / h) * 0.9));
        set({
          camera: {
            zoom,
            x: window.innerWidth / 2 - (x + w / 2) * zoom,
            y: window.innerHeight / 2 - (y + h / 2) * zoom,
          },
        });
        break;
      }

      case 'agent.spotlight':
        set({ spotlight: msg.shapeIds.length > 0 ? { ids: msg.shapeIds, dim: msg.dim } : null });
        break;

      case 'agent.highlight': {
        const next = { ...useStore.getState().highlights };
        for (const id of msg.shapeIds) next[id] = msg.kind;
        set({ highlights: next });
        window.setTimeout(() => {
          for (const id of msg.shapeIds) useStore.getState().clearHighlight(id);
        }, msg.ms);
        break;
      }

      case 'agent.suggest':
        set({ suggestions: [...useStore.getState().suggestions, { opId: msg.opId, summary: msg.summary, shapeIds: msg.shapeIds }] });
        break;

      case 'agent.ask':
        set({ ask: { askId: msg.askId, question: msg.question, ...(msg.options ? { options: msg.options } : {}) } });
        break;

      case 'agent.say':
        // M4 接 TTS；现在先进对话流
        s.pushChat({ id: `say_${nanoid(6)}`, role: 'ai', text: msg.text });
        break;

      case 'error':
        s.pushChat({ id: `err_${nanoid(6)}`, role: 'ai', text: `⚠️ ${msg.message}${msg.detail ? `\n${msg.detail}` : ''}` });
        set({ turnRunning: false });
        break;

      default:
        break;
    }
  }

  return (
    <div className="app">
      <ErrorBoundary label="画布">
        <CanvasStage conn={conn} me={me} />
      </ErrorBoundary>
      <Toolbar />
      <AgentPanel conn={conn} />
    </div>
  );
}
