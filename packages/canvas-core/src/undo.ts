import * as Y from 'yjs';
import type { Scene } from './scene.js';
import { ORIGIN_AI, ORIGIN_LOCAL } from './scene.js';

/**
 * 撤销栈。
 *
 * 建在 Yjs 的 UndoManager 之上，而不是自己记"反操作"——
 * CRDT 里撤销一次删除要精确还原图元、撤销一次修改要还原旧值，
 * 而且期间别人可能已经改过同一个图元。这些边界情况 Yjs 已经处理好了，
 * 自己写一遍只会写错。
 *
 * 两个关键设定：
 *
 * **captureTimeout: 0** —— Yjs 默认把 500ms 内的改动并成一步撤销，
 * 那会把两笔独立的笔画并到一起。设成 0 之后，一个 Yjs 事务 = 一步撤销；
 * 而 Scene 的每个写方法正好是一个事务、共享一个 opId，
 * 于是"一次动作 = 一个 opId = 一次撤销"这条设计就自动成立了：
 * AI 画一座房子产生十几个图元，用户按一次 Cmd+Z 全部消失。
 *
 * **trackedOrigins = {local, ai}** —— 只撤自己的和 AI 的。
 * 别的协作者的改动绝不能被我撤掉，那是他们的内容。
 */
export interface UndoOptions {
  /** 额外纳入撤销范围的来源标记 */
  extraOrigins?: unknown[];
}

export function createUndoManager(scene: Scene, opts: UndoOptions = {}): Y.UndoManager {
  const shapes = scene.doc.getMap('shapes');
  return new Y.UndoManager(shapes, {
    captureTimeout: 0,
    trackedOrigins: new Set<unknown>([ORIGIN_LOCAL, ORIGIN_AI, ...(opts.extraOrigins ?? [])]),
  });
}

/** 撤销栈深度，用来决定按钮能不能点 */
export interface UndoDepth {
  undo: number;
  redo: number;
}

export const undoDepth = (m: Y.UndoManager): UndoDepth => ({
  undo: m.undoStack.length,
  redo: m.redoStack.length,
});
