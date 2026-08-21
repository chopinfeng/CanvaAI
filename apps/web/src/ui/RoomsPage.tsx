import { useEffect, useMemo, useRef, useState } from 'react';
import { VisionSettings } from './VisionSettings';
import { ago, fetchRooms, goto, needsVisionKey, slug, uploadPaperToNewRoom, type RoomInfo } from './rooms';

/**
 * 画布列表页——这个应用的门厅。
 *
 * 在它之前，换一张卷子只能手改地址栏的 ?room=，而房间名全在人脑子里记着；
 * 攒到二十几张之后，"我上次那道积分题在哪张画布上"这个问题根本没法回答。
 *
 * 所以列表上必须有**标题**而不只是房间名：`ugrad` `ugrad-scan` `amc3`
 * 摆在一起谁也认不出来，而"Geometry — Triangle with an Altitude"一眼就够了。
 * 标题是服务端从画布上第一段文字读出来的，不需要用户额外命名。
 */

export function RoomsPage() {
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [showVision, setShowVision] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchRooms()
      .then(setRooms)
      .catch((e: Error) => setErr(e.message));
  }, []);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return rooms ?? [];
    return (rooms ?? []).filter(
      (r) => r.id.toLowerCase().includes(k) || (r.title ?? '').toLowerCase().includes(k),
    );
  }, [rooms, q]);

  const pickPaper = () => {
    // 没配 key 就先把设置推到他面前，而不是传完了再说"你没配 key"
    if (needsVisionKey()) {
      setShowVision(true);
      return;
    }
    fileRef.current?.click();
  };

  const create = () => {
    if (name.trim()) goto(slug(name));
  };

  return (
    <div className="rp">
      <header className="rp-head">
        <div>
          <h1>画布</h1>
          <p className="rp-sub">
            每张画布是一份独立的题目和一份独立的学习记录——知识图谱按画布名分开记掌握度。
          </p>
        </div>
        <button className="rp-link" onClick={() => setShowVision(true)}>
          视觉模型设置
        </button>
      </header>

      <div className="rp-bar">
        <input
          className="rp-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜画布名或题目"
          spellCheck={false}
        />
        <input
          className="rp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder="新画布名字"
          spellCheck={false}
        />
        <button className="rp-new" onClick={create} disabled={!name.trim()}>
          建空画布
        </button>
        <button className="rp-paper" onClick={pickPaper} disabled={busy}>
          {busy ? '上传中…' : '传试卷 → 新画布'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setBusy(true);
            void uploadPaperToNewRoom(f).then((msg) => {
              setBusy(false);
              if (msg) setErr(msg);
            });
          }}
        />
      </div>

      {err && <div className="rp-err">{err}</div>}

      {rooms === null && !err && <div className="rp-empty">正在读…</div>}
      {rooms !== null && shown.length === 0 && (
        <div className="rp-empty">
          {rooms.length === 0 ? '还没有画布。传一张试卷，或者建一张空的。' : '没有匹配的画布。'}
        </div>
      )}

      <div className="rp-grid">
        {shown.map((r) => (
          <article key={r.id} className={`rp-card${r.broken ? ' is-broken' : ''}`} onClick={() => goto(r.id)}>
            <div className="rp-card-top">
              <h2 title={r.title ?? r.id}>{r.title ?? r.id}</h2>
              {r.live && <span className="rp-live" title="此刻有人开着">在用</span>}
              {r.broken && <span className="rp-broken" title="磁盘上的快照解不开，打开会是空白">坏了</span>}
            </div>
            <div className="rp-id">{r.id}</div>
            <div className="rp-meta">
              <span>{r.shapes} 个图元</span>
              <span>·</span>
              <span>{ago(r.modified)}</span>
            </div>
            <div className="rp-actions">
              {/* 阻止冒泡：卡片整体是"打开画布"，这两个是例外 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  goto(r.id);
                }}
              >
                打开
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  location.search = `view=kg&learner=${encodeURIComponent(r.id)}`;
                }}
              >
                知识图谱
              </button>
            </div>
          </article>
        ))}
      </div>

      {showVision && <VisionSettings onClose={() => setShowVision(false)} />}
    </div>
  );
}
