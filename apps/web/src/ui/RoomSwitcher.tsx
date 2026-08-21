import { useEffect, useRef, useState } from 'react';
import { ago, fetchRooms, goto, needsVisionKey, slug, uploadPaperToNewRoom, type RoomInfo } from './rooms';

/**
 * 在多张画布之间切换。
 *
 * 每个房间是一张独立的画布，也是一份**独立的学习记录**——
 * 知识图谱里的 learnerId 就是房间名。所以"换一张试卷"和
 * "换一个学生"在数据上是同一件事，这个面板同时决定了两者。
 *
 * 切换用整页跳转而不是原地换连接：房间名一变，Yjs 文档、WebSocket、
 * awareness、撤销栈全都要换掉。原地换的话，任何一处没清干净都会
 * 表现成"上一张画布的东西漏到这张来了"——而这种 bug 极难复现。
 * 一次跳转把这些全部归零，代价只是几十毫秒。
 */

export function RoomSwitcher({ current, onNeedKey }: { current: string; onNeedKey: () => void }) {
  const [open, setOpen] = useState(false);
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // 打开时才拉列表：这东西大部分时间是关着的
  useEffect(() => {
    if (!open) return;
    setErr(null);
    fetchRooms()
      .then(setRooms)
      .catch((e: Error) => setErr(e.message));
  }, [open]);

  // 点外面关掉
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', off);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const uploadToNew = async (file: File) => {
    setErr(null);
    const msg = await uploadPaperToNewRoom(file);
    if (msg) setErr(msg);
  };

  const pickPaper = () => {
    if (needsVisionKey()) {
      setOpen(false);
      onNeedKey();
      return;
    }
    fileRef.current?.click();
  };

  return (
    <div className="rooms" ref={boxRef}>
      <button className="rooms-btn" onClick={() => setOpen((v) => !v)} title="切换画布 / 新建一张">
        <span className="rooms-dot" />
        {current}
        <span className="rooms-caret">▾</span>
      </button>

      {open && (
        <div className="rooms-menu">
          <div className="rooms-head">
            画布
            <button className="rooms-all" onClick={() => (location.search = '')}>
              全部 ›
            </button>
          </div>

          <div className="rooms-list">
            {rooms === null && <div className="rooms-empty">加载中…</div>}
            {rooms?.length === 0 && <div className="rooms-empty">还没有画布</div>}
            {rooms?.map((r) => (
              <button
                key={r.id}
                className={`rooms-item${r.id === current ? ' is-current' : ''}`}
                onClick={() => (r.id === current ? setOpen(false) : goto(r.id))}
              >
                {/* 标题认卷子，房间名认画布——光有标题的话，同一道题灌进几张
                    画布时列表上会出现四行一模一样的字 */}
                <span className="rooms-name" title={r.title ?? r.id}>
                  {r.title ?? r.id}
                  {r.title && <em className="rooms-slug">{r.id}</em>}
                </span>
                <span className="rooms-when">{r.id === current ? '当前' : ago(r.modified)}</span>
              </button>
            ))}
          </div>

          <div className="rooms-new">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && goto(slug(name))}
              placeholder="新画布名字，回车新建"
              spellCheck={false}
            />
            <button className="rooms-paper" onClick={pickPaper}>
              传试卷到新画布
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadToNew(f);
                e.target.value = '';
              }}
            />
          </div>

          {err && <div className="rooms-err">{err}</div>}
          <div className="rooms-note">
            每张画布是独立的题目和独立的学习记录（知识图谱按画布名分开记）。
          </div>
        </div>
      )}
    </div>
  );
}
