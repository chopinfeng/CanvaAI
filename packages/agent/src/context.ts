import { locateInImages, round, shapeBounds } from '@canvai/canvas-core';
import type { Scene } from '@canvai/canvas-core';
import type { AgentInputEvent, LayerId, Rect } from '@canvai/protocol';
import type { SessionState } from './tools/context.js';

/**
 * Context Header —— agentic context 的常驻部分。
 *
 * 只放"决定下一步该查什么"所必需的信息，其余一律让 Agent 自己用工具取。
 * 目标 200~400 token；画布再复杂，这里也不会跟着膨胀。
 *
 * 位置很关键：它必须放在消息序列的**最后**，紧挨当轮用户输入。
 * 放前面会击穿前缀缓存。
 */

export interface HeaderInput {
  scene: Scene;
  session: SessionState;
  /** 本轮触发 Agent 的事件 */
  events: AgentInputEvent[];
  turnNo: number;
  /** 上一轮 AI 产生的 opId 和摘要，帮它认出自己刚做过什么 */
  lastActions?: string[];
}

export function buildContextHeader(input: HeaderInput): string {
  const { scene, session, events, turnNo } = input;
  const lines: string[] = [];

  /* ---- 画布概况 ---- */
  const counts = new Map<LayerId, number>();
  for (const s of scene.all()) counts.set(s.layer, (counts.get(s.layer) ?? 0) + 1);
  const layerStr = [...counts.entries()].map(([l, n]) => `${l}(${n})`).join(' ') || '空';
  const content = scene.contentBounds();

  lines.push(
    `[画布] ${scene.size} 个图元 · 图层 ${layerStr}` +
      (scene.size > 0 ? ` · 内容范围 ${fmtRect(content)}` : ' · 画布是空的'),
  );
  lines.push(`[视口] 用户正看着 ${fmtRect(session.viewport)}，缩放 ${round(session.zoom, 2)}x`);

  /* ---- 选中 ---- */
  if (session.selection.length > 0) {
    const sel = session.selection
      .map((id) => scene.get(id))
      .filter(Boolean)
      .slice(0, 6)
      .map((s) => `${s!.id}(${s!.type}${s!.meta.role ? `,${s!.meta.role}` : ''})`)
      .join(' ');
    lines.push(`[选中] ${sel}${session.selection.length > 6 ? ` 等 ${session.selection.length} 个` : ''}`);
    lines.push(`  └ 用户说"这个/它"时指的很可能是这些`);
  }

  /* ---- 本轮事件 ---- */
  for (const e of events) {
    switch (e.kind) {
      case 'text':
        lines.push(`[用户输入] ${e.text}`);
        break;
      case 'speech':
        lines.push(`[用户说] ${e.text}`);
        break;
      case 'draw': {
        const names = e.shapeIds
          .map((id) => scene.get(id))
          .filter(Boolean)
          .map((s) => `${s!.id}(${s!.type})`)
          .slice(0, 8)
          .join(' ');
        lines.push(`[用户刚画了] ${e.shapeIds.length} 个图元于 ${fmtRect(e.region as Rect)}：${names}`);

        // 画在扫描件上的标注，位置要说清楚。位图内容对你是黑箱，
        // 但"落在图的哪一块"靠坐标就能算准——别答"我看不到你标的位置"。
        const images = scene
          .all()
          .filter((s) => s.type === 'image')
          .map((s) => ({ id: s.id, bounds: shapeBounds(s), label: s.meta.label as string | undefined }));
        for (const hit of locateInImages(e.region as Rect, images)) {
          lines.push(`  └ ${hit.text}`);
        }
        break;
      }
      case 'select':
        lines.push(`[用户选中了] ${e.shapeIds.join(' ')}`);
        break;
      case 'answer':
        lines.push(`[用户回答] ${e.answer}`);
        break;
    }
  }

  /* ---- 上轮动作 ---- */
  if (input.lastActions && input.lastActions.length > 0) {
    lines.push(`[你上一轮] ${input.lastActions.slice(-3).join('；')}`);
  }

  /* ---- 模式 ---- */
  lines.push(
    `[模式] ${session.editMode === 'direct' ? 'direct（可直接修改用户内容）' : 'suggest（改用户内容需先提案）'} · 第 ${turnNo} 轮`,
  );

  /* ---- 辅导账本 ----
   * 每一轮都摆一遍，成本几十个 token。不摆的话，讲到第五轮时
   * "这次辅导要讲到哪儿为止"只剩下越滚越远的对话历史，模型会自己找台阶收尾。 */
  if (session.mode === 'tutor' && session.tutor) {
    const t = session.tutor;
    lines.push(`[辅导中] 用户要学会的是：${t.goal}`);
    if (t.pending) {
      lines.push(`  ⚠ 他回答了「${t.pending.answer}」，你还没判对错。先 tutor_judge，再问下一个。`);
    }
    if (!t.markedSinceAsk) {
      lines.push(
        '  ⚠ 自上一个问题以来你还没在图上指过任何东西。' +
          '下一个问题之前，先 canvas_highlight(ms:0) / canvas_spotlight 把要看的那块点亮，' +
          '需要的话在 annot 层补一条辅助线或一个标注——让他看见你在说哪儿，别让他在文字里猜。',
      );
    }
    if (t.outline.length === 0) {
      lines.push('  └ 还没拆题。先 tutor_plan 列出他要逐个攻克的小问，否则没人知道这次讲到哪算完。');
    } else {
      for (const i of t.outline) lines.push(`  ${i.done ? '✓' : '▢'} ${i.text}`);
      const left = t.outline.filter((i) => !i.done);
      lines.push(
        left.length > 0
          ? `  └ 还剩 ${left.length} 个没解决，这次辅导不能结束。当前该攻的是「${left[0]!.text}」。`
          : '  └ 都解决了，可以 tutor_finish 收尾。',
      );
    }
  }

  return lines.join('\n');
}

const fmtRect = ([x, y, w, h]: Rect): string =>
  `(${Math.round(x)},${Math.round(y)} ${Math.round(w)}×${Math.round(h)})`;

/**
 * 会话摘要：历史太长时压缩早期轮次。
 * 保留最近 keepTurns 轮原文，更早的折成一段事实性摘要。
 */
export function summarizeOldTurns(
  actions: Array<{ turnNo: number; summary: string }>,
  keepTurns: number,
): string | null {
  const old = actions.filter((a) => a.turnNo <= actions.length - keepTurns);
  if (old.length === 0) return null;
  return `[早期回合摘要] ${old.map((a) => `#${a.turnNo} ${a.summary}`).join('；')}`;
}

/** 给 lastActions 用的简短描述 */
export function describeDiff(scene: Scene, created: string[], updated: string[], deleted: string[]): string {
  const parts: string[] = [];
  if (created.length > 0) {
    const roles = created
      .map((id) => scene.get(id))
      .filter(Boolean)
      .map((s) => s!.meta.role ?? s!.type);
    parts.push(`画了 ${created.length} 个（${[...new Set(roles)].join('/')}）`);
  }
  if (updated.length > 0) parts.push(`改了 ${updated.length} 个`);
  if (deleted.length > 0) parts.push(`删了 ${deleted.length} 个`);
  return parts.join('，');
}

export const _fmtRect = fmtRect;
export const _shapeBounds = shapeBounds;
