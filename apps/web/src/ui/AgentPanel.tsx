import { useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import type { ToolCallView } from '@canvai/protocol';
import type { Connection } from '../net/connection';
import { answerOf, thinkingOf, useStore } from '../store';

/** 工具名 → 给人看的说法。用户不需要知道函数名。 */
const TOOL_LABEL: Record<string, string> = {
  canvas_query: '扫了一眼画布',
  canvas_describe: '看清楚了图形',
  canvas_measure: '量了一下',
  canvas_hit_test: '找了找那个位置',
  canvas_snapshot: '看了看画面',
  canvas_get_selection: '看了你选中的',
  canvas_get_viewport: '看了你的视野',
  canvas_create: '画了',
  canvas_update: '改了',
  canvas_delete: '删了',
  canvas_transform: '挪了挪',
  canvas_style: '调了样式',
  canvas_group: '编了组',
  canvas_align: '对齐了',
  canvas_distribute: '排匀了',
  canvas_connect: '连了线',
  canvas_ink: '手绘了一笔',
  canvas_erase: '擦掉了',
  canvas_zoom_to: '带你看向',
  canvas_spotlight: '聚光',
  canvas_highlight: '高亮',
  canvas_pointer_move: '移动光标',
  canvas_layer_set_visible: '切换图层',
  canvas_layer_clear: '清空图层',
  interact_say: '说',
  interact_ask_user: '问你',
  interact_suggest: '提交提案',
  interact_set_status: '更新状态',
  interact_set_todo: '列了计划',
  tutor_plan: '拆题',
  tutor_judge: '判对错',
  tutor_finish: '收尾',
};

const VERDICT: Record<string, { icon: string; label: string }> = {
  right: { icon: '✓', label: '答对了' },
  partly: { icon: '≈', label: '对了一半' },
  wrong: { icon: '✗', label: '不对' },
};

export function AgentPanel({ conn }: { conn: Connection }) {
  const [input, setInput] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const chat = useStore((s) => s.chat);
  const todos = useStore((s) => s.todos);
  const suggestions = useStore((s) => s.suggestions);
  const ask = useStore((s) => s.ask);
  const turnRunning = useStore((s) => s.turnRunning);
  const aiStatus = useStore((s) => s.aiStatus);
  const awaitingIdle = useStore((s) => s.awaitingIdle);
  const foreground = useStore((s) => s.foreground);
  const tutorMode = useStore((s) => s.tutorMode);
  const pushChat = useStore((s) => s.pushChat);
  const set = useStore((s) => s.set);
  const removeSuggestion = useStore((s) => s.removeSuggestion);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat, todos]);

  const send = () => {
    const text = input.trim();
    if (!text) return;
    // 用户主动开口就不必再等停手了，把攒下的笔画一并送出，
    // Agent 这一回合才能同时看到"他画了什么"和"他说了什么"
    useStore.getState().flushDraws?.();
    pushChat({ id: `u_${nanoid(6)}`, role: 'user', text });
    conn.send({ t: 'user.text', text });
    setInput('');
  };

  const answer = (text: string) => {
    if (!ask || !text.trim()) return;
    conn.send({ t: 'agent.answer', askId: ask.askId, answer: text });
    pushChat({ id: `u_${nanoid(6)}`, role: 'user', text });
    set({ ask: null });
    setInput(''); // 之前只有 send() 清了输入框，回答问题后残留在那儿
  };

  const resolve = (opId: string, accept: boolean) => {
    conn.send({ t: 'suggest.resolve', opId, accept });
    removeSuggestion(opId);
  };

  if (collapsed) {
    return (
      <button className="panel-toggle" onClick={() => setCollapsed(false)} title="展开对话">
        💬
      </button>
    );
  }

  return (
    <div className="agent-panel">
      <header>
        <span className="dot" data-running={turnRunning} />
        <strong>AI 搭档</strong>
        {aiStatus && <em>{aiStatus}</em>}
        {!turnRunning && !aiStatus && awaitingIdle && (
          foreground ? (
            <em className="waiting" title="你停手 5 秒后我再接手，免得打断你">
              等你画完…
            </em>
          ) : (
            <em className="waiting" title="页面不在前台，我先不动你的画布。切回来我再接着看">
              等你回来…
            </em>
          )
        )}
        <button
          className={`mode-toggle ${tutorMode ? 'on' : ''}`}
          title={
            tutorMode
              ? '辅导模式：我一步步问，你自己算出答案。点一下切回协作模式'
              : '协作模式：正常回答。点一下切到辅导模式，我就不直接给答案了'
          }
          onClick={() => {
            const next = !tutorMode;
            set({ tutorMode: next });
            conn.send({ t: 'session.config', mode: next ? 'tutor' : 'assist' });
          }}
        >
          {tutorMode ? '辅导中' : '辅导'}
        </button>
        {turnRunning && (
          <button className="link" onClick={() => conn.send({ t: 'agent.abort' })}>
            停止
          </button>
        )}
        <button className="link" onClick={() => setCollapsed(true)}>
          收起
        </button>
      </header>

      {todos.length > 0 && (
        <div className="todos">
          {todos.map((t, i) => (
            <div key={i} className={t.done ? 'done' : ''}>
              {t.done ? '✓' : '○'} {t.text}
            </div>
          ))}
        </div>
      )}

      <div className="chat" ref={listRef}>
        {chat.length === 0 && (
          <div className="empty">
            <p>画点什么，然后告诉我你想做什么。</p>
            <ul>
              <li>「在这个方块上面加个屋顶」</li>
              <li>「帮我把这几个节点连成流程图」</li>
              <li>「这道几何题怎么做？画条辅助线看看」</li>
            </ul>
            <p className="hint">你画的时候我不会插嘴，等你停手几秒才接手。想让我立刻看，直接说一声就行。</p>
          </div>
        )}

        {chat.map((c) => {
          // 判定单独渲染：用户要一眼看见自己刚才那步对不对，不能混在普通气泡里
          if (c.verdict) {
            const v = VERDICT[c.verdict]!;
            return (
              <div key={c.id} className={`verdict verdict-${c.verdict}`}>
                <span className="mark">{v.icon}</span>
                <span className="label">{v.label}</span>
                <span className="why">{c.text}</span>
              </div>
            );
          }

          const answer = answerOf(c);
          const thinking = thinkingOf(c);
          return (
            <div key={c.id} className={`msg msg-${c.role}`}>
              {c.tools && c.tools.length > 0 && (
                <div className="tools">
                  {c.tools.map((t) => (
                    <ToolChip key={t.id} call={t} />
                  ))}
                </div>
              )}
              {thinking && <Thinking text={thinking} live={!!c.streaming && !answer} />}
              {answer && <div className="bubble">{answer}</div>}
              {c.streaming && !answer && !thinking && <div className="bubble pending">…</div>}
            </div>
          );
        })}
      </div>

      {suggestions.map((s) => (
        <div key={s.opId} className="suggestion">
          <div className="summary">{s.summary}</div>
          <div className="actions">
            <button className="accept" onClick={() => resolve(s.opId, true)}>
              接受
            </button>
            <button onClick={() => resolve(s.opId, false)}>不用了</button>
          </div>
        </div>
      ))}

      {ask && (
        <div className="ask">
          <div className="question">{ask.question}</div>
          {ask.options && (
            <div className="options">
              {ask.options.map((o) => (
                <button key={o} onClick={() => answer(o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (ask) answer(input.trim());
              else send();
            }
          }}
          placeholder={ask ? '回答上面的问题…' : '说说你想画什么…'}
          rows={2}
        />
        <button onClick={() => (ask ? answer(input.trim()) : send())} disabled={!input.trim()}>
          发送
        </button>
      </div>
    </div>
  );
}

/**
 * 思考轨迹。
 *
 * 模型在调工具之间写的正文是推理，不是对用户说的话。
 * 还在跑的时候显示末尾几行（让人看到它在动），跑完就收起来——
 * 想看细节可以展开，但默认不占用户的注意力。
 */
function Thinking({ text, live }: { text: string; live: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const tailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (live) tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [text, live]);

  if (live && !expanded) {
    return (
      <div className="thinking live" ref={tailRef}>
        {text}
      </div>
    );
  }

  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? '▾' : '▸'} 思考过程
      </button>
      {expanded && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function ToolChip({ call }: { call: ToolCallView }) {
  const label = TOOL_LABEL[call.name] ?? call.name;
  const detail =
    call.summary ??
    (call.diff
      ? [
          call.diff.created.length > 0 ? `${call.diff.created.length} 个新图形` : '',
          call.diff.updated.length > 0 ? `改了 ${call.diff.updated.length} 个` : '',
          call.diff.deleted.length > 0 ? `删了 ${call.diff.deleted.length} 个` : '',
        ]
          .filter(Boolean)
          .join('，')
      : '');

  return (
    <div className={`chip chip-${call.state}`} title={call.error ?? JSON.stringify(call.args)}>
      <span className="chip-icon">{call.state === 'running' ? '◌' : call.state === 'ok' ? '✓' : '✕'}</span>
      <span>{label}</span>
      {detail && <span className="chip-detail">{detail}</span>}
      {call.state === 'error' && <span className="chip-detail">{call.error}</span>}
    </div>
  );
}
