import { tutorFinish, tutorPlan, err, ok } from '@canvai/protocol';
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
    return err(
      '当前不在辅导中，没有可记的进度',
      '这个工具只在辅导模式下有意义。用户想被一步步教的时候，系统会自动进入辅导模式。',
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
  const preChecked = first && a.items.some((i) => i.done);

  // 换清单时把老的 done 带过来：模型每轮重发全量，偶尔会漏标已完成的那条，
  // 漏一次就等于让用户把做出来的小问再做一遍。文字相同就认为是同一条。
  const wasDone = new Set(t.outline.filter((i) => i.done).map((i) => i.text.trim()));
  t.outline = a.items.map((i) => ({
    text: i.text,
    done: first ? false : i.done || wasDone.has(i.text.trim()),
  }));

  ctx.emit({ t: 'agent.todo', items: t.outline });

  const left = t.outline.filter((i) => !i.done);
  return ok({
    outline: t.outline,
    remaining: left.length,
    ...(preChecked
      ? {
          note:
            '开局的清单一律从零开始，你标的 done 已被重置——用户还没答过任何一问。' +
            '他要是自称做出了某一问，先让他把结果说出来，你确认无误再 tutor_plan 打勾。',
        }
      : {}),
    summary:
      left.length > 0
        ? `还剩 ${left.length} 个小问，下一个：${left[0]!.text}`
        : '小问都解决了，可以 tutor_finish 收尾',
  });
};

export const execTutorFinish: ToolExecutor = async (raw, ctx) => {
  const a = tutorFinish.input.parse(raw);
  const t = ctx.session.tutor;
  if (!t) return err('当前不在辅导中', '没有正在进行的辅导，不用结束。');

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
  ctx.session.tutor = null;
  ctx.session.mode = 'assist';
  ctx.emit({ t: 'agent.todo', items: [] });
  ctx.emit({ t: 'agent.say', text: a.summary, interruptible: true });
  ctx.emit({
    t: 'session.mode',
    mode: 'assist',
    auto: true,
    note: `这道题讲完了（${count} 个小问都是你自己做出来的）。要再讲一道就说一声。`,
  });

  return ok({ finished: true, solved: count });
};
