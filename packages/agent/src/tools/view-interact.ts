import { rectCenter, round, shapeBounds, unionBounds } from '@canvai/canvas-core';
import type { Rect, Shape } from '@canvai/protocol';
import {
  canvasHighlight,
  canvasPointerMove,
  canvasSpotlight,
  canvasZoomTo,
  err,
  interactAskUser,
  interactSay,
  interactSetStatus,
  interactSetTodo,
  interactSuggest,
  ok,
} from '@canvai/protocol';
import type { ToolExecutor } from './context.js';

/* ------------------------------------------------------------------ *
 * canvas.view —— 讲解时把用户的注意力带到该看的地方
 * ------------------------------------------------------------------ */

export const execZoomTo: ToolExecutor = async (raw, ctx) => {
  const a = canvasZoomTo.input.parse(raw);

  let region: Rect | undefined = a.region as Rect | undefined;
  if (!region && a.ids && a.ids.length > 0) {
    const shapes = a.ids.map((id) => ctx.scene.get(id)).filter(Boolean) as Shape[];
    if (shapes.length === 0) return err('这些图元都不存在', '先 canvas_query 拿到有效 id。');
    region = unionBounds(shapes.map(shapeBounds));
  }
  if (!region) return err('需要 ids 或 region 之一', '传要聚焦的图元 id 列表，或一个 [x,y,w,h] 区域。');

  const padded: Rect = [region[0] - a.padding, region[1] - a.padding, region[2] + a.padding * 2, region[3] + a.padding * 2];
  ctx.emit({ t: 'agent.viewport', rect: padded, animate: true });
  ctx.session.viewport = padded;
  return ok({ region: padded.map((n) => round(n, 1)) });
};

/**
 * 聚焦：把这几个图元持续标出来。
 *
 * 早先它是真的"聚光"——把没点名的部分整体压暗。讲题时反而更糟：
 * 学生要同时看清标出来的那条边和它周围的图，周围一暗参照物就没了。
 * 现在只是一个"一直亮着"的高亮，别处一点不动。
 */
export const execSpotlight: ToolExecutor = async (raw, ctx) => {
  const a = canvasSpotlight.input.parse(raw);
  if (a.ids.length === 0) {
    ctx.emit({ t: 'agent.highlight', shapeIds: [], kind: 'pulse', ms: 0 });
    return ok({ cleared: true });
  }
  const exist = a.ids.filter((id) => ctx.scene.has(id));
  if (exist.length === 0) {
    return err(
      `这些 id 在画布上都不存在：${a.ids.join(' ')}`,
      '常见原因是引用了自己刚删掉的辅助图形。先 canvas_query 拿当前的 id，或者重新画一个再聚焦。',
    );
  }
  ctx.emit({ t: 'agent.highlight', shapeIds: exist, kind: 'pulse', ms: 0 });
  return ok({ focused: exist });
};

export const execHighlight: ToolExecutor = async (raw, ctx) => {
  const a = canvasHighlight.input.parse(raw);

  // 空数组是「把高亮清掉」，工具说明里就是这么写的。
  // 早先这里和"id 全都不存在"走同一条分支，于是每次收拾上一处标记都报一次错。
  if (a.ids.length === 0) {
    ctx.emit({ t: 'agent.highlight', shapeIds: [], kind: a.kind, ms: a.ms });
    return ok({ cleared: true });
  }

  const exist = a.ids.filter((id) => ctx.scene.has(id));
  if (exist.length === 0) {
    // 实测最常见的成因：拿自己上一步删掉的辅助图形的 id 再去高亮
    return err(
      `这些 id 在画布上都不存在：${a.ids.join(' ')}`,
      '常见原因是引用了自己刚删掉的辅助图形。先 canvas_query 拿当前的 id' +
        '（讲题时按 layer:"annot" 或 role 筛更快），或者干脆 canvas_create 重新画一个再高亮——' +
        'create 的返回里就带着新 id。',
    );
  }
  ctx.emit({ t: 'agent.highlight', shapeIds: exist, kind: a.kind, ms: a.ms });
  const missing = a.ids.filter((id) => !ctx.scene.has(id));
  return ok({ highlighted: exist, ...(missing.length > 0 ? { skippedMissing: missing } : {}) });
};

export const execPointerMove: ToolExecutor = async (raw, ctx) => {
  const a = canvasPointerMove.input.parse(raw);
  let to: { x: number; y: number };

  if (typeof a.to === 'string') {
    const s = ctx.scene.get(a.to);
    if (!s) return err(`图元 ${a.to} 不存在`, '传 {x,y} 坐标，或先 canvas_query 确认 id。');
    to = rectCenter(shapeBounds(s));
  } else {
    to = a.to;
  }

  ctx.emit({ t: 'agent.pointer', to, ms: a.ms });
  // 让光标真的先走过去，再落笔——这几百毫秒是"在场感"的来源
  await sleep(Math.min(a.ms, 800), ctx.signal);
  return ok({ at: { x: round(to.x, 1), y: round(to.y, 1) } });
};

/* ------------------------------------------------------------------ *
 * interact
 * ------------------------------------------------------------------ */

export const execSay: ToolExecutor = async (raw, ctx) => {
  const a = interactSay.input.parse(raw);
  ctx.emit({ t: 'agent.say', text: a.text, interruptible: a.interruptible });
  return ok({ said: a.text.length });
};

export const execAskUser: ToolExecutor = async (raw, ctx) => {
  const a = interactAskUser.input.parse(raw);

  // 辅导时：他上一次的回答还没判定，就不许问下一个。
  // 一路只被追问、从不被告知对错，答十道题也不知道自己错在哪。
  const t = ctx.session.tutor;
  if (ctx.session.mode === 'tutor' && t?.pending) {
    return err(
      `他刚才回答了「${t.pending.answer}」，你还没说这答案对不对`,
      '先调 tutor_judge 给个判定（right / partly / wrong 加一句为什么），再来问下一个问题。',
    );
  }

  const answer = await ctx.ask(a.question, a.options);
  return ok({ answer });
};

export const execSuggest: ToolExecutor = async (raw, ctx) => {
  const a = interactSuggest.input.parse(raw);
  const shapes = ctx.scene.all().filter((s) => s.opId === a.opId);
  if (shapes.length === 0) {
    return err(
      `找不到 opId=${a.opId} 对应的内容`,
      '先用 canvas_create 在 suggest 图层画出你的提案，用返回的 diff.opId 调用本工具。',
    );
  }
  ctx.emit({ t: 'agent.suggest', opId: a.opId, summary: a.summary, shapeIds: shapes.map((s) => s.id) });
  return ok({ pending: shapes.length, note: '已提交给用户确认，等待用户接受或拒绝' });
};

export const execSetStatus: ToolExecutor = async (raw, ctx) => {
  const a = interactSetStatus.input.parse(raw);
  ctx.emit({ t: 'agent.status', text: a.text });
  return ok({});
};

export const execSetTodo: ToolExecutor = async (raw, ctx) => {
  const a = interactSetTodo.input.parse(raw);
  ctx.emit({ t: 'agent.todo', items: a.items });
  return ok({ total: a.items.length, done: a.items.filter((i) => i.done).length });
};

/* ------------------------------------------------------------------ */

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
