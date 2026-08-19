import { useCallback, useEffect, useRef, useState } from 'react';
import { layout, type Sim } from './layout';

/**
 * 知识图谱页。
 *
 * 一条设计上的克制：**不画整张图**。一万个节点铺开是一团毛线，
 * 好看，但没人能从里面看出任何东西。真正有用的永远是
 * "以我正在学的这一点为中心的周围两跳"——所以这页始终围绕一个焦点节点，
 * 换焦点靠搜索或者点节点。
 *
 * 颜色只表达一件事：这个学生**在这一点上**处于什么状态。
 * 掌握 / 学着呢 / 薄弱 / 没碰过。别的信息（学科、层级）用形状和大小带，
 * 不再往颜色上叠——颜色一多，第一眼能读出来的信息就没了。
 */

interface KgNode {
  id: string;
  label: string;
  name: string;
  properties: Record<string, unknown>;
}
interface KgEdge {
  source: string;
  target: string;
  type: string;
  properties?: Record<string, unknown>;
}
type Band = 'mastered' | 'learning' | 'shaky' | 'unseen';

const BAND_COLOR: Record<Band, string> = {
  mastered: '#059669',
  learning: '#2563eb',
  shaky: '#dc2626',
  unseen: '#a8a29e',
};
const BAND_LABEL: Record<Band, string> = {
  mastered: '基本掌握',
  learning: '学着呢',
  shaky: '薄弱',
  unseen: '还没碰过',
};

/** 前置关系是这张图的主线，画粗一点；其余是背景 */
const EDGE_STYLE: Record<string, { color: string; width: number; dash?: number[] }> = {
  prerequisites_for: { color: '#7c3aed', width: 1.8 },
  tests_concept: { color: '#f59e0b', width: 1, dash: [3, 3] },
  tests_skill: { color: '#f59e0b', width: 1, dash: [3, 3] },
};
const EDGE_DEFAULT: { color: string; width: number; dash?: number[] } = { color: '#d6d3d1', width: 0.8 };

export function KgPage() {
  const params = new URLSearchParams(location.search);
  const learner = params.get('learner') ?? params.get('room') ?? 'exam-set';

  const [root, setRoot] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KgNode[]>([]);
  const [sub, setSub] = useState<{ nodes: KgNode[]; edges: KgEdge[]; mastery: Record<string, { level: number; band: Band }> } | null>(null);
  const [focus, setFocus] = useState<KgNode | null>(null);
  const [stats, setStats] = useState<{ nodes: number; edges: number; ready: boolean; hint?: string } | null>(null);
  const [ranking, setRanking] = useState<Array<{ id: string; name: string; level: number; band: Band; attempts: number }>>([]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Sim | null>(null);

  /* ---- 概况 + 这个学生的掌握度榜 ---- */
  useEffect(() => {
    void fetch('/kg/stats')
      .then((r) => r.json())
      .then((s) => {
        setStats(s);
        // 没指定焦点时，从这个学生练过的第一个知识点开始——
        // 直接给他看自己的东西，比给一个随机起点有用
        if (!root && s.ready) void pickInitial();
      })
      .catch(() => setStats(null));
  }, []);

  const loadRanking = useCallback(async () => {
    const r = await fetch(`/kg/mastery/${encodeURIComponent(learner)}`).then((x) => x.json());
    setRanking(r.mastery ?? []);
    return r.mastery as Array<{ id: string }> | undefined;
  }, [learner]);

  async function pickInitial(): Promise<void> {
    const m = await loadRanking();
    if (m && m.length > 0) setRoot(m[0]!.id);
    else {
      const s = await fetch('/kg/search?q=数&limit=1').then((r) => r.json());
      if (s.hits?.[0]) setRoot(s.hits[0].id);
    }
  }

  /* ---- 换焦点就重新取一片子图 ---- */
  useEffect(() => {
    if (!root) return;
    void fetch(`/kg/around/${encodeURIComponent(root)}?depth=2&cap=90&learner=${encodeURIComponent(learner)}`)
      .then((r) => r.json())
      .then((d) => {
        setSub(d);
        setFocus(d.nodes?.find((n: KgNode) => n.id === root) ?? null);
      });
  }, [root, learner]);

  /* ---- 力导向布局 + 画 ---- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sub || sub.nodes.length === 0) return;

    const sim = layout(sub.nodes.map((n) => n.id), sub.edges, root!);
    simRef.current = sim;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
    };
    resize();
    window.addEventListener('resize', resize);

    const ctx = canvas.getContext('2d')!;
    const byId = new Map(sub.nodes.map((n) => [n.id, n]));
    let raf = 0;

    const draw = () => {
      sim.step();
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2, h / 2);

      for (const e of sub.edges) {
        const a = sim.pos(e.source);
        const b = sim.pos(e.target);
        if (!a || !b) continue;
        const st = EDGE_STYLE[e.type] ?? EDGE_DEFAULT;
        ctx.strokeStyle = st.color;
        ctx.lineWidth = st.width;
        ctx.setLineDash(st.dash ?? []);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const n of sub.nodes) {
        const p = sim.pos(n.id);
        if (!p) continue;
        const band = (sub.mastery[n.id]?.band ?? 'unseen') as Band;
        const isRoot = n.id === root;
        // Concept 是主角，画实心圆；其他类型小一圈，避免抢戏
        const r = isRoot ? 11 : n.label === 'Concept' ? 7 : 5;

        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = BAND_COLOR[band];
        ctx.globalAlpha = band === 'unseen' ? 0.45 : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (isRoot) {
          ctx.strokeStyle = '#1c1917';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // 只给焦点和它的直接邻居写名字，全写就成一团墨
        if (isRoot || n.label === 'Concept') {
          ctx.fillStyle = isRoot ? '#1c1917' : '#57534e';
          ctx.font = `${isRoot ? 600 : 400} ${isRoot ? 13 : 11}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(n.name.slice(0, 10), p.x, p.y + r + 12);
        }
      }
      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onClick = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left - rect.width / 2;
      const y = ev.clientY - rect.top - rect.height / 2;
      const hit = sub.nodes.find((n) => {
        const p = sim.pos(n.id);
        return p && Math.hypot(p.x - x, p.y - y) < 12;
      });
      if (hit) {
        setFocus(byId.get(hit.id) ?? null);
        if (hit.id !== root) setRoot(hit.id);
      }
    };
    canvas.addEventListener('click', onClick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('click', onClick);
    };
  }, [sub, root]);

  const search = async (q: string) => {
    setQuery(q);
    if (q.trim().length === 0) return setHits([]);
    const r = await fetch(`/kg/search?q=${encodeURIComponent(q)}&limit=8`).then((x) => x.json());
    setHits(r.hits ?? []);
  };

  if (stats && !stats.ready) {
    return (
      <div className="kg-empty">
        <h1>知识图谱还没装数据</h1>
        <p>{stats.hint}</p>
        <code>npx tsx apps/server/scripts/fetch-kg.ts</code>
      </div>
    );
  }

  return (
    <div className="kg-page">
      <aside className="kg-side">
        <header>
          <h1>知识图谱</h1>
          <span className="kg-learner">{learner}</span>
        </header>

        <input
          className="kg-search"
          value={query}
          onChange={(e) => void search(e.target.value)}
          placeholder="搜知识点，如「负数」"
        />
        {hits.length > 0 && (
          <ul className="kg-hits">
            {hits.map((h) => (
              <li key={h.id}>
                <button
                  onClick={() => {
                    setRoot(h.id);
                    setHits([]);
                    setQuery('');
                  }}
                >
                  {h.name} <em>{h.label}</em>
                </button>
              </li>
            ))}
          </ul>
        )}

        {focus && (
          <section className="kg-focus">
            <h2>{focus.name}</h2>
            <div className="kg-band" style={{ color: BAND_COLOR[(sub?.mastery[focus.id]?.band ?? 'unseen') as Band] }}>
              {BAND_LABEL[(sub?.mastery[focus.id]?.band ?? 'unseen') as Band]}
              {sub?.mastery[focus.id] && <b>{sub.mastery[focus.id]!.level.toFixed(2)}</b>}
            </div>
            {typeof focus.properties.definition === 'string' && <p>{focus.properties.definition}</p>}
          </section>
        )}

        <section className="kg-legend">
          {(['mastered', 'learning', 'shaky', 'unseen'] as Band[]).map((b) => (
            <span key={b}>
              <i style={{ background: BAND_COLOR[b] }} />
              {BAND_LABEL[b]}
            </span>
          ))}
        </section>

        <section className="kg-rank">
          <h3>他的掌握度（薄弱在前）</h3>
          {ranking.length === 0 && <p className="kg-hint">还没有学习记录。讲完一道题就会出现。</p>}
          <ul>
            {ranking.slice(0, 14).map((r) => (
              <li key={r.id}>
                <button onClick={() => setRoot(r.id)}>
                  <i style={{ background: BAND_COLOR[r.band] }} />
                  <span className="kg-rank-name">{r.name}</span>
                  <span className="kg-rank-lv">{r.level.toFixed(2)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <footer>
          图谱数据 <a href="https://github.com/haolpku/K12-KGraph">K12-KGraph</a>
          （CC BY-NC-SA 4.0）
        </footer>
      </aside>

      <canvas ref={canvasRef} className="kg-canvas" />
    </div>
  );
}
