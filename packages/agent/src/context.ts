import { round, shapeBounds } from '@canvai/canvas-core';
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
