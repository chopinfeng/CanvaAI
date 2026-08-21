import type { LayerId } from '@canvai/protocol';
import type { Connection } from '../net/connection';
import { PaperUpload } from './PaperUpload';
import { type Tool, useStore } from '../store';

const TOOLS: Array<{ id: Tool; label: string; key: string }> = [
  { id: 'select', label: '选择', key: 'V' },
  { id: 'pen', label: '画笔', key: 'P' },
  { id: 'rect', label: '矩形', key: 'R' },
  { id: 'ellipse', label: '椭圆', key: 'O' },
  { id: 'line', label: '直线', key: 'L' },
  { id: 'arrow', label: '箭头', key: 'A' },
  { id: 'text', label: '文字', key: 'T' },
  { id: 'eraser', label: '橡皮', key: 'E' },
];

const COLORS = ['#111827', '#dc2626', '#2563eb', '#059669', '#d97706', '#7c3aed'];

const LAYERS: Array<{ id: LayerId; label: string; hint: string }> = [
  { id: 'user', label: '我的', hint: '你画的内容' },
  { id: 'ai', label: 'AI', hint: 'AI 画的内容，可整层隐藏' },
  { id: 'annot', label: '批注', hint: 'AI 的辅助线与讲解标记' },
  { id: 'suggest', label: '提案', hint: 'AI 等你确认的改动' },
];

export function Toolbar({ conn, onNeedKey }: { conn: Connection; onNeedKey: () => void }) {
  const tool = useStore((s) => s.tool);
  const strokeColor = useStore((s) => s.strokeColor);
  const strokeWidth = useStore((s) => s.strokeWidth);
  const layerVisible = useStore((s) => s.layerVisible);
  const camera = useStore((s) => s.camera);
  const status = useStore((s) => s.status);
  const set = useStore((s) => s.set);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const undoDepth = useStore((s) => s.undoDepth);
  const redoDepth = useStore((s) => s.redoDepth);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);

  const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+';

  return (
    <>
      <div className="toolbar">
        <div className="tool-group">
          {/* 传试卷放在最前面：它是这条工具栏上唯一"带东西进来"的入口 */}
          <PaperUpload conn={conn} onNeedKey={onNeedKey} />
          <span className="tool-sep" />
          <button
            className="tool"
            onClick={() => undo?.()}
            disabled={undoDepth === 0}
            title={`撤销（${mod}Z）。AI 画的东西也能撤，一次动作撤一步`}
          >
            ↶ 撤销
          </button>
          <button
            className="tool"
            onClick={() => redo?.()}
            disabled={redoDepth === 0}
            title={`重做（${mod}⇧Z）`}
          >
            ↷ 重做
          </button>
        </div>

        <div className="divider" />

        <div className="tool-group">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool ${tool === t.id ? 'active' : ''}`}
              onClick={() => set({ tool: t.id })}
              title={`${t.label} (${t.key})`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="divider" />

        <div className="tool-group">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`swatch ${strokeColor === c ? 'active' : ''}`}
              style={{ background: c }}
              onClick={() => set({ strokeColor: c })}
              title={c}
            />
          ))}
        </div>

        <div className="divider" />

        <input
          type="range"
          min={1}
          max={12}
          value={strokeWidth}
          onChange={(e) => set({ strokeWidth: Number(e.target.value) })}
          title={`线宽 ${strokeWidth}`}
          className="width-slider"
        />
      </div>

      <div className="layer-panel">
        <div className="layer-title">图层</div>
        {LAYERS.map((l) => (
          <label key={l.id} className="layer-row" title={l.hint}>
            <input type="checkbox" checked={layerVisible[l.id]} onChange={() => toggleLayer(l.id)} />
            <span>{l.label}</span>
          </label>
        ))}
        <div className="zoom-row">
          <button onClick={() => set({ camera: { ...camera, zoom: Math.max(0.05, camera.zoom / 1.25) } })}>−</button>
          <span>{Math.round(camera.zoom * 100)}%</span>
          <button onClick={() => set({ camera: { ...camera, zoom: Math.min(8, camera.zoom * 1.25) } })}>+</button>
        </div>
        <div className={`conn conn-${status}`}>
          {status === 'open' ? '已连接' : status === 'connecting' ? '连接中…' : '已断开，重连中…'}
        </div>
      </div>
    </>
  );
}
