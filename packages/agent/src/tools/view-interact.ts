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

  /**
   * 提问前得在图上指过东西——这条本来只是 context.ts 里每轮都摆一遍的
   * 提示词，指望模型自己看见了照做。真机录像验证过：一场六问的辅导，
   * 提示词原样挂在每一轮的上下文里，模型还是只在第 1 问照做了，
   * 后面五问全程零指点——学生自己答对了每一步，但"图文并茂"从第二问起
   * 就名存实亡。这类事关"讲得像不像那么回事"的约束，靠劝是劝不动的，
   * 得跟 tutor_plan 的拆题条数一样改成硬闸。
   *
   * 只在画布上确实有东西可指时才拦——纯口头讨论、画布是空的，
   * 拦下来也无处可指，白白把用户晾在那儿。
   */
  if (ctx.session.mode === 'tutor' && t && t.outline.length > 0 && !t.markedSinceAsk && ctx.scene.all().length > 0) {
    return err(
      '这道题画布上有内容，但这一问你还没在图上指过要问的是哪块',
      '先用 canvas_highlight / canvas_spotlight / canvas_pointer_move 之类的工具点亮或指向你要问的那部分' +
        '（或者补一笔辅助线、标注），再来问——让他看见你在说哪儿，别让他在文字里猜。',
    );
  }

  /**
   * 判完上一题，板书没跟上，不许问下一题——用户直接要求"尽量做到每次
   * 对话都能在板书上留下内容"，跟上面 markedSinceAsk 是同一类问题、
   * 同一种药方。真机复现过：提示词把"结论"改成"推理过程"之后，板书
   * 密度确实有所提升，但还是不稳——有的轮次判完就写了一笔，有的轮次
   * 判完直接问下一题，板书原地不动，学生刚做的那步运算就那么散在
   * 聊天记录里，没落进画布。用 askedQuestions 判断"是否已经真的问过、
   * 判过至少一轮"——刚进辅导、第一个问题还没问出去的那一刻不该被拦，
   * 那会儿压根没有"上一轮的推理过程"可写。
   */
  if (ctx.session.mode === 'tutor' && t && t.askedQuestions.length > 0 && !t.drawnSinceJudge) {
    t.drawAskBlockCount += 1;
    /**
     * 连着卡够次数就放行，不能死磕到底——跟 drawBlockCount / graphicsBlockCount
     * 是同一个道理（见 context.ts 里 drawAskBlockCount 的注释）：真机复现过一场
     * 死局，判完题连拦三次提问，模型没能很快补上一笔，回合活活耗成空转超时，
     * 整场作废，比"这一步没画"更糟。放行之后计数清零——下一轮判完照样要求
     * 先画，不是从此躺平。
     */
    if (t.drawAskBlockCount < 4) {
      return err(
        '刚判完上一题，但这一步的推理过程还没写进板书区',
        '先用 canvas_create（annot 或 ai 层）把刚才判定的这一步——他求出的中间结果、' +
          '用到的公式、算式——写一笔上去，再问下一个问题。不是又攒到最后才想起来补。',
      );
    }
    t.drawAskBlockCount = 0;
  }

  /**
   * 这个问题已经问过、也判过 right 了，不许一字不差再问一遍。
   *
   * 真机复现过：拆题的条目挂着具体符号也没撞黑名单（"理解题目条件和
   * 图形"），但依然是个没有明确"何时算完成"标准的条目——学生把
   * "直线和圆可能有哪些位置关系"答对了两次，账本却一直不打勾，
   * 老师一字不差把这问题问了第二遍，讲了十几分钟卡在原地。
   * 黑名单堵不完所有能绕出这种效果的措辞，但"同一个问题问了两遍"
   * 这个症状本身是能直接拦的，不用先猜出它是怎么绕出来的。
   */
  if (ctx.session.mode === 'tutor' && t?.askedQuestions.includes(a.question.trim())) {
    return err(
      '这个问题一字不差地问过了，而且他上次答对了',
      '账本这条一直没打勾，不是因为他没答上来——是因为这条小问本身太空泛，' +
        '没法用一个问题问完。先用 tutor_plan 把这条标成 done，或者换一个更具体的' +
        '下一步问题（比如往下一个真正要算的量去问），不要再问同一句了。',
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
