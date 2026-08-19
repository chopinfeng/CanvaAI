import { kgLookup, tutorFinish, tutorJudge, tutorPlan, err, ok } from '@canvai/protocol';
import type { ToolExecutor } from './context.js';

/**
 * 辅导账本的两个工具。
 *
 * 它们存在的理由是一件很具体的事：辅导跑到一半就散了。
 * 模型讲完第 (1) 问，用户说声"懂了"，它顺势说"那这道题就讲完了"——
 * 第 (2) 问再没人提起，模式也一直挂在辅导上不下来。
 *
 * 所以把"这次要讲到哪儿为止"从模型的印象里挪到会话状态里：
 * tutor_plan 记账，tutor_finish 结账，**账没平就不许结**。
 */

export const execTutorPlan: ToolExecutor = async (raw, ctx) => {
  const a = tutorPlan.input.parse(raw);
  const t = ctx.session.tutor;
  if (!t) {
    // 最常见的成因不是用错工具，是用户在你这一轮跑到一半时喊了停
    // （"直接告诉我答案""先不学了"），账本当场就销了。
    return err(
      '辅导已经结束了，没有进度可记',
      '多半是用户刚刚自己退出了辅导。别再记进度、也别想着把它拉回来——' +
        '按他现在的要求答就行（他要答案就给答案）。',
    );
  }

  /**
   * 开局那一次不许预先打勾。
   *
   * 实测第一次拆题就把第 (1) 问标成 done 了——用户还一个字都没答。
   * 那一问就此跳过，"确保他问的题被完整解答"当场落空。
   * 就算他自称做出来了，也得先让他说出结果、确认无误，再回来打勾。
   */
  const first = t.outline.length === 0;

  // 换清单时把老的 done 带过来：模型每轮重发全量，偶尔会漏标已完成的那条，
  // 漏一次就等于让用户把做出来的小问再做一遍。文字相同就认为是同一条。
  const wasDone = new Set(t.outline.filter((i) => i.done).map((i) => i.text.trim()));

  /**
   * 新打的勾要有门票：上次打勾之后用户得真答对过一次（tutor_judge → right）。
   *
   * 只挡开局那一次是不够的——实测模型会在同一轮里连调两次 tutor_plan，
   * 第一次老实拆题，第二次就把第 (1) 问标上 done，用户还一个字都没答。
   */
  const newlyDone = a.items.filter((i) => i.done && !wasDone.has(i.text.trim()));
  const unearned = (first || t.rightSince === 0) && newlyDone.length > 0;

  t.outline = a.items.map((i) => ({
    text: i.text,
    done: unearned ? wasDone.has(i.text.trim()) : i.done || wasDone.has(i.text.trim()),
  }));
  if (!unearned && newlyDone.length > 0) t.rightSince = 0;

  ctx.emit({ t: 'agent.todo', items: t.outline });

  const left = t.outline.filter((i) => !i.done);
  return ok({
    outline: t.outline,
    remaining: left.length,
    ...(unearned
      ? {
          note:
            `你标的 done 已被撤回（${newlyDone.map((i) => i.text).join('；')}）——` +
            '自上次打勾以来，用户还没有哪一次回答被你判为 right。' +
            '打勾的标准是"他自己算出来了"：先 interact_ask_user 问他，' +
            '等他答对、你用 tutor_judge 判 right，再回来打这个勾。',
        }
      : {}),
    summary:
      left.length > 0
        ? `还剩 ${left.length} 个小问，下一个：${left[0]!.text}`
        : '小问都解决了，可以 tutor_finish 收尾',
  });
};

/**
 * 判定用户上一次的回答。
 *
 * 少了这一步，辅导就变成了单向的追问：他答一句，Agent 接着问下一句，
 * 他始终不知道自己刚才那步站不站得住。所以做成硬约束——
 * 手上压着一次没判定的回答，interact_ask_user 会被拒。
 */
export const execTutorJudge: ToolExecutor = async (raw, ctx) => {
  const a = tutorJudge.input.parse(raw);
  const t = ctx.session.tutor;
  if (!t) {
    return err(
      '辅导已经结束了，不用再判了',
      '多半是用户刚刚自己退出了辅导。直接按他现在的要求答。',
    );
  }
  if (!t.pending) {
    return err(
      '没有待判定的回答',
      '用户还没回答过问题，或者你已经判过了。直接用 interact_ask_user 提问就行。',
    );
  }

  const judged = t.pending;
  t.pending = null;
  // 只有"完全对"才换来一张打勾的门票。半对说明这一步还没走通。
  if (a.verdict === 'right') t.rightSince += 1;

  /**
   * 把这次判定记到知识点上——先攒着，讲完再一次写进去。
   *
   * 中途就写的话，学生半路走人会在图谱上留下一串"被引导着做对了"的记录，
   * 而他其实并没有走完。
   * guided 恒为 true：辅导模式下他是被一路问出来的，
   * 和自己独立做对不能记一样的分（见 knowledge/mastery.ts）。
   */
  for (const id of a.conceptIds ?? []) {
    t.attempts.push({ conceptId: id, ok: a.verdict === 'right', guided: true });
  }

  ctx.emit({ t: 'agent.judge', verdict: a.verdict, comment: a.comment });

  return ok({
    judged: judged.answer,
    verdict: a.verdict,
    summary:
      a.verdict === 'right'
        ? '判为正确，可以问下一步了'
        : a.verdict === 'partly'
          ? '判为部分正确，下一个问题该对着错的那半问'
          : '判为错误，下一个问题该让他自己看出矛盾，不要直接纠正',
  });
};

export const execTutorFinish: ToolExecutor = async (raw, ctx) => {
  const a = tutorFinish.input.parse(raw);
  const t = ctx.session.tutor;
  if (!t) return err('当前不在辅导中', '没有正在进行的辅导，不用结束。');

  if (t.pending) {
    return err(
      '他刚才的回答你还没给判定',
      `先用 tutor_judge 对「${t.pending.answer}」表个态，再收尾——` +
        '最后一次回答连个对错都没有，这次辅导就是烂尾的。',
    );
  }

  if (t.outline.length === 0) {
    return err(
      '你还没拆过题，无从判断这次辅导讲完了没有',
      '先用 tutor_plan 把用户问的这道题拆成小问。如果他确实已经全都自己解出来了，' +
        '就把这些小问连同 done:true 一起补上，再结束。',
    );
  }

  const left = t.outline.filter((i) => !i.done);
  if (left.length > 0) {
    return err(
      `还有 ${left.length} 个小问没解决：${left.map((i) => i.text).join('；')}`,
      `辅导不能就这么停在这里。回到「${left[0]!.text}」，用 interact_ask_user 提一个他答得上来的问题。` +
        '如果他其实已经自己算出来了，先用 tutor_plan 把那条标成 done 再来结束。',
    );
  }

  const count = t.outline.length;

  /**
   * 讲完了才写图谱。
   *
   * 写失败不能把收尾也搞砸——学生这道题确实讲完了，
   * 掌握度没记上是我们的问题，不该表现成"这次辅导没结束"。
   */
  let learned = 0;
  if (ctx.knowledge && t.attempts.length > 0) {
    try {
      await ctx.knowledge.record(t.attempts);
      learned = t.attempts.length;
    } catch {
      learned = 0;
    }
  }

  ctx.session.tutor = null;
  ctx.session.mode = 'assist';
  ctx.emit({ t: 'agent.todo', items: [] });
  // 走到头的那一下要有个明确的收束——十几轮"再想想"之后，
  // 只发一句总结太轻了
  ctx.emit({ t: 'agent.celebrate', solved: count });
  ctx.emit({ t: 'agent.say', text: a.summary, interruptible: true });
  ctx.emit({
    t: 'session.mode',
    mode: 'assist',
    auto: true,
    note: `（这次辅导到此结束——这道题的 ${count} 个小问都是你自己做出来的。要再讲一道就说一声。）`,
  });

  return ok({ finished: true, solved: count, knowledgeUpdated: learned });
};

/**
 * 在知识图谱里查知识点。
 *
 * 拆完题查一次，把「勾股定理」这几个字落到一个真实的 id 上——
 * 之后 tutor_judge 带上这个 id，学生答得对不对才落得进他的掌握度。
 * 没有这一步，图谱就只是个好看的装饰，永远不会跟着学生长。
 */
export const execKgLookup: ToolExecutor = async (raw, ctx) => {
  const a = kgLookup.input.parse(raw);
  if (!ctx.knowledge) {
    return err(
      '这个部署没有接知识图谱',
      '照常辅导就行，不用再查了。tutor_judge 的 conceptIds 也不用填。',
    );
  }

  const hits = ctx.knowledge.search(a.query, a.limit);
  if (hits.length === 0) {
    return ok({
      hits: [],
      note: `图谱里没找到「${a.query}」。换个更常见的说法再试一次（比如用课本上的叫法），或者就不挂知识点了。`,
    });
  }

  return ok({
    hits: hits.map((h) => ({
      ...h,
      prerequisites: ctx.knowledge!.prerequisites(h.id),
    })),
    summary: `找到 ${hits.length} 个：${hits.map((h) => h.name).join('、')}`,
  });
};
