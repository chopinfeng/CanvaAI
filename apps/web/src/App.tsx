import { useEffect, useMemo, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import type { Author, ServerMessage } from '@canvai/protocol';
import { AgentPanel } from './ui/AgentPanel';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Toolbar } from './ui/Toolbar';
import { Confetti } from './ui/Confetti';
import { VisionSettings } from './ui/VisionSettings';
import { CanvasStage } from './canvas/CanvasStage';
import { Connection } from './net/connection';
import { shapeBounds } from '@canvai/canvas-core';
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
  const [showVision, setShowVision] = useState(false);
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

      case 'session.reset':
        set({
          chat: [],
          todos: [],
          suggestions: [],
          ask: null,
          aiStatus: '',
          highlights: {},
          tutorMode: false,
          celebrate: null,
        });
        break;

      case 'agent.ask.done':
        // 可能是这台答的，也可能是别处答的——只要 id 对得上就收掉
        if (useStore.getState().ask?.askId === msg.askId) set({ ask: null });
        break;

      case 'paper.progress': {
        // 转换过程直接说在聊天里：用户刚扔进来一张图，得知道它到哪一步了
        const icon = msg.phase === 'failed' ? '✗' : msg.phase === 'done' ? '✓' : '…';
        s.pushChat({ id: `paper_${nanoid(6)}`, role: 'ai', text: `${icon} ${msg.message}` });
        break;
      }

      case 'agent.celebrate':
        set({ celebrate: (useStore.getState().celebrate ?? 0) + 1 });
        s.pushChat({
          id: `cheer_${nanoid(6)}`,
          role: 'ai',
          text: `🎉 这道题讲完了——${msg.solved} 问都是你自己做出来的。`,
        });
        break;

      case 'agent.judge':
        s.pushChat({
          id: `judge_${nanoid(6)}`,
          role: 'ai',
          text: msg.comment,
          verdict: msg.verdict,
        });
        break;

      case 'session.mode': {
        set({ tutorMode: msg.mode === 'tutor' });
        if (msg.auto) {
          s.pushChat({
            id: `mode_${nanoid(6)}`,
            role: 'ai',
            // 退出辅导的理由不止一种（讲完了 / 要答案 / 去做别的），
            // 服务端知道是哪一种就带 note 过来，别用一句通稿盖掉
            text:
              msg.note ??
              (msg.mode === 'tutor'
                ? '（已切到辅导模式：我一步步问，你自己算出答案。想直接要结果就说一声。）'
                : '（已切回协作模式：直接给你结果。）'),
          });
        }
        break;
      }

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
        /**
         * AI 把用户的视线带过去。
         *
         * 这里必须防住坏参数：视口是 Agent 说了算的，一个离谱的 rect
         * 会把人扔到一片空白上——而用户完全不知道发生了什么，
         * 只会觉得"画布没了"。宁可忽略这次指令，也不能让画面失去内容。
         */
        if (!msg.rect) break;

        const [rx, ry, rw, rh] = msg.rect;
        if (![rx, ry, rw, rh].every(Number.isFinite) || rw <= 0 || rh <= 0) {
          console.warn('[canvai] 忽略异常的视口指令', msg.rect);
          break;
        }

        /**
         * 窗口尺寸拿不到就别算了。
         *
         * 标签页在后台、窗口最小化时 innerWidth 会是 0，硬算出来的相机
         * 参数是垃圾（实测缩放被压到 0.05，用户回到前台看见一片空白）。
         * 这和 Konva 在 0 宽高上 drawImage 崩溃是同一个根因。
         */
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (vw < 100 || vh < 100) break;

        const shapes = useStore.getState().shapes;

        /**
         * 把请求区域收敛到实际有内容的范围内。
         *
         * 视口是 Agent 说了算的，而它偶尔会给出一个大得离谱的区域
         * （实测出现过 25600×14400）。照单全收的话缩放会被压到最小，
         * 用户面对的就是一片空白，还完全不知道发生了什么。
         * 与其拒绝，不如收敛——落到内容上总比落到虚空里强。
         */
        let target: [number, number, number, number] = [rx, ry, rw, rh];
        if (shapes.length > 0) {
          const bs = shapes.map(shapeBounds);
          const cx0 = Math.min(...bs.map((b) => b[0]));
          const cy0 = Math.min(...bs.map((b) => b[1]));
          const cx1 = Math.max(...bs.map((b) => b[0] + b[2]));
          const cy1 = Math.max(...bs.map((b) => b[1] + b[3]));
          const pad = 80;

          const x0 = Math.max(rx, cx0 - pad);
          const y0 = Math.max(ry, cy0 - pad);
          const x1 = Math.min(rx + rw, cx1 + pad);
          const y1 = Math.min(ry + rh, cy1 + pad);

          if (x1 - x0 < 1 || y1 - y0 < 1) {
            console.warn('[canvai] 视口指令与画布内容不相交，已忽略', msg.rect);
            break;
          }
          target = [x0, y0, x1 - x0, y1 - y0];
        }

        const [x, y, w, h] = target;
        const zoom = Math.max(0.05, Math.min(3, Math.min(vw / w, vh / h) * 0.9));
        set({
          camera: {
            zoom,
            x: vw / 2 - (x + w / 2) * zoom,
            y: vh / 2 - (y + h / 2) * zoom,
          },
        });
        break;
      }

      case 'agent.highlight': {
        // 空数组 = 清除全部高亮
        if (msg.shapeIds.length === 0) {
          set({ highlights: {} });
          break;
        }
        // 辅导时提问前的标注要一直亮着（ms=0）——学生思考作答要几十秒，
        // 默认 1.2 秒早灭了，等于没标
        const next = msg.ms === 0 ? {} : { ...useStore.getState().highlights };
        for (const id of msg.shapeIds) next[id] = msg.kind;
        set({ highlights: next });
        if (msg.ms > 0) {
          window.setTimeout(() => {
            for (const id of msg.shapeIds) useStore.getState().clearHighlight(id);
          }, msg.ms);
        }
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
      <Toolbar conn={conn} onNeedKey={() => setShowVision(true)} />
      <AgentPanel conn={conn} onOpenVision={() => setShowVision(true)} />
      <Confetti />
      {showVision && <VisionSettings onClose={() => setShowVision(false)} />}
    </div>
  );
}
