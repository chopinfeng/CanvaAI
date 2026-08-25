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
  let t = ctx.session.tutor;

  if (!t && ctx.session.tutorJustExited) {
    // 用户刚喊过停（"直接告诉我答案""先不学了"），别把他拖回去
    return err(
      '辅导已经结束了，没有进度可记',
      '用户刚刚自己退出了辅导。别再记进度、也别想着把它拉回来——' +
        '按他现在的要求答就行（他要答案就给答案）。',
    );
  }

  if (!t) {
    /**
     * 没在辅导模式却来拆题 —— 那就开始辅导。
     *
     * 早先这里一律报错，理由写的是"多半是用户刚退出了"。但实测下来更常见的
     * 是另一种：用户确实在求辅导，只是那句话没被意图正则认出来
     * （"老师你一步步问我吧"——`一步步` 后面的动词表里没有 `问`）。
     * 于是模型判断对了、动手了，被一个正则否决，整场辅导照讲，
     * 但账本全空：不拆题、不判定、不记掌握度，而且不报错。三次演练里栽了三次。
     *
     * 模型决定开始拆题，这件事本身就是最强的意图信号。正则该是捷径，不是门闸。
     */
    t = {
      goal: a.items[0]?.text.slice(0, 120) ?? '这道题',
      outline: [],
      startedTurn: 0,
      pending: null,
      rightSince: 0,
      markedSinceAsk: false,
      drawCount: 0,
      askedQuestions: [],
      stuckStreak: 0,
      attempts: [],
      concepts: [],
    };
    ctx.session.tutor = t;
    ctx.session.mode = 'tutor';
    ctx.emit({ t: 'session.mode', mode: 'tutor', auto: true });
  }

  /**
   * 开局那一次不许预先打勾。
   *
   * 实测第一次拆题就把第 (1) 问标成 done 了——用户还一个字都没答。
   * 那一问就此跳过，"确保他问的题被完整解答"当场落空。
   * 就算他自称做出来了，也得先让他说出结果、确认无误，再回来打勾。
   */
  const first = t.outline.length === 0;

  /**
   * 开局拆题的条数要跟题目原文里的 (1)(2)(3) 对得上——不能光靠提示词劝。
   *
   * 实测复现过：提示词里已经写了"小问编号要一一对应"，模型还是把一道标了
   * (1)~(5) 五问的题拆成 3 条"理解题目条件/分析图形结构/逐步求解"这种
   * 流程步骤，账本从一开始就是缩水的，后面判完 3 条就收尾，(4)(5) 两问
   * 用户压根没被问起。提示词对模型的约束是概率性的，这种会直接影响
   * "题目有没有讲完"的判断必须是硬闸，不能只靠劝。
   *
   * 只在第一次拆题时查——后续每一轮都重发全量清单，用同样的口径查会
   * 把"这一轮先聚焦其中两问，其余的还没提"误判成漏题。
   */
  if (first) {
    const nums = new Set<string>();
    for (const s of ctx.scene.all()) {
      if (!s.text) continue;
      for (const m of s.text.matchAll(/[(（]\s*(\d{1,2})\s*[)）]/g)) nums.add(m[1]!);
    }
    if (nums.size > 0 && a.items.length < nums.size) {
      return err(
        `题目原文里标了 ${nums.size} 个小问（${[...nums].join('、')}），这次只拆了 ${a.items.length} 条`,
        '重新读一遍题目原文（canvas_query / canvas_describe），按 (1)(2)(3)... 的编号逐条对应地拆，' +
          '不要把它们揉成"理解条件/计算/验证"这种流程步骤——每个编号至少算一条小问。',
      );
    }
  }

  /**
   * 拆出来的小问里不许混"理解题目内容"这种空转条目。
   *
   * 真机复现过：这次条数够了（题目 3 问，拆了 4 条），但混进去的第 4 条
   * 是"理解题目内容"——一个没有明确对错标准的条目。学生把题目复述对了、
   * 被判过好几次 right，这一条却始终没被标 done，账本一直卡在这儿，
   * 于是老师反反复复重问同一句"题目要求什么"，讲了十几分钟一步都
   * 没往前挪。跟"条数不够"是同一类事故的另一种变形：数量够了，
   * 但混进了一条谁也不知道怎样才算"完成"的空话。
   */
  const VAGUE_ITEM = /^(理解|审|分析|明确|回顾)(一下)?(题目|题干|条件|图形|内容|要求|结构|题意)*$|^(逐步)?求解$|^总结(思路|方法)?$|^验证结果$|^计算$/;
  const vague = a.items.filter((i) => VAGUE_ITEM.test(i.text.replace(/^[(（]\s*\d{1,2}\s*[)）]\s*/, '').trim()));
  if (vague.length > 0) {
    return err(
      `这几条不是真正的小问，是空转的流程标签：${vague.map((i) => i.text).join('；')}`,
      '"理解题目内容"这类条目没有明确的对错标准，打不上勾，会话会卡在这儿反复重问。' +
        '把它换成题目原文里真正要算的那一步（比如"写出拉格朗日函数 L(x,y,λ)"），' +
        '每一条都要有一个具体、可判定对错的答案。',
    );
  }

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

  /**
   * 同一批没打勾的小问，答对过还是连着两轮原样不动——不许再这样耗下去。
   *
   * 前两道闸（黑名单挡空转标签、精确匹配挡一字不差的重复提问）看的都是
   * "问题长什么样"，真机复现过绕过它们的新花样：一条措辞完全具体、
   * 也没撞黑名单的条目（"求函数在约束条件下的极值点"），学生把它内含的
   * 每一个子步骤都依次答对了——列方程、解方程、验证性质、复述全过程——
   * 账本却始终不给这条打勾，老师只能一轮轮换着法子重问同一件事，
   * 措辞每次都不完全一样，精确匹配的闸也躲了过去。这道闸看的是
   * "账本动没动"：不管话术怎么变，undone 的集合连着两轮纹丝不动，
   * 而这期间用户明明又答对过，本身就是信号。
   */
  const prevUndone = new Set(t.outline.filter((i) => !i.done).map((i) => i.text.trim()));
  const incomingUndone = new Set(a.items.filter((i) => !i.done).map((i) => i.text.trim()));
  const sameUndoneSet =
    prevUndone.size > 0 &&
    prevUndone.size === incomingUndone.size &&
    [...prevUndone].every((x) => incomingUndone.has(x));

  if (!first && t.rightSince > 0 && sameUndoneSet) {
    t.stuckStreak += 1;
  } else {
    t.stuckStreak = 0;
  }

  if (t.stuckStreak >= 2) {
    const stuck = [...incomingUndone][0] ?? '';
    return err(
      `「${stuck}」这条小问，用户已经答对过至少一次了，账本却连着两轮都没打勾`,
      '这条大概率是把好几个子步骤揉在了一起，卡在"什么时候算完成"上。' +
        '别再照原样重发这条清单了：要么现在就把它标成 done——他刚才的正确回答' +
        '已经覆盖了这条要考的内容；要么把它拆成两条更小的小问，各自有清楚的' +
        '对错标准，再往下问。不要只是换个说法把同一件事再问一遍。',
    );
  }

  /**
   * 顺手把这道题落在图谱上的知识点查出来存着。
   *
   * 用 mentions 不用 search：小问是一整句话，而 search 是拿查询串去匹配
   * 节点名——实测「在两个直角三角形里分别用勾股定理写出 AD²」返回空，
   * 而「勾股定理」返回六条。方向必须反过来扫。
   *
   * 用小问的文字不用 goal：goal 常常是题目标题（这次是英文的
   * "Geometry — Triangle with an Altitude"），而图谱是中文 K12 课标，
   * 对不上。小问是老师自己写的中文，"勾股定理""直角三角形"就在里面。
   *
   * 查不到也没关系：那只是说明这道题不在图谱覆盖范围内，
   * 判定照常进行，只是不留掌握度记录。
   */
  if (ctx.knowledge && t.concepts.length === 0) {
    const seen = new Set<string>();
    for (const item of a.items) {
      for (const hit of ctx.knowledge.mentions(item.text, 2)) {
        if (seen.size >= 6) break;
        seen.add(hit.id);
      }
    }
    t.concepts = [...seen];
  }

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
   * 记下这次问过的问题——一字不差问第二遍会被 interact_ask_user 拦下
   * （见 view-interact.ts）。
   *
   * 原来只记 right（理由是"答错或半对之后换个角度追问是正常教学，
   * 不能拦"）。真机复现过这道理由本身站不住：学生答"不太清楚"，
   * 判了 wrong，然后老师把同一句"你知道如何求二阶常系数线性微分方程
   * 的通解吗？"一字不差地问了四遍，中间只穿插了一句"没关系，我们
   * 一起来学"——四轮里没有一次真的换了角度或把问题拆小。"换个角度
   * 追问"这件事，靠的从来不是判定结果是 right 还是 wrong，靠的是
   * 问题的**文字有没有真的变**——上面那条"答错/半对之后换个角度追问"
   * 的例子本来就是拿两句不同的话在测，不会被这次改动拦下。
   */
  t.askedQuestions.push(judged.question.trim());

  /**
   * 把这次判定记到知识点上——先攒着，讲完再一次写进去。
   *
   * 中途就写的话，学生半路走人会在图谱上留下一串"被引导着做对了"的记录，
   * 而他其实并没有走完。
   * guided 恒为 true：辅导模式下他是被一路问出来的，
   * 和自己独立做对不能记一样的分（见 knowledge/mastery.ts）。
   */
  /**
   * 模型给了 conceptIds 就用它的（它最清楚这一步考的是什么）；
   * 没给就用拆题时反查出来的那批。
   *
   * 兜底不是可有可无：实测 stealth/ox-alpha 整场一次都没调 kg_lookup，
   * 七次判定一个知识点都没记上，而且全程不报错——
   * "学生学到了什么"这条主线就那么静静地空了一整场。
   */
  const ids = a.conceptIds?.length ? a.conceptIds : t.concepts;
  for (const id of ids) {
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

  /**
   * 画得不够多，不许收尾。
   *
   * 分两轮才摸到这条真正的门槛。第一轮全程零画，加了"至少画一笔"——
   * 结果第二轮卡着底线交差：一整场三问的辅导，从头到尾只画了一笔，
   * 用户反馈"这也太敷衍了"，让参照老师上课的板书。板书是讲一步写
   * 一步，公式、算式、图形随着讲解逐步铺开，不是讲完全程再补一笔
   * 象征性的意思意思。所以门槛不能是"画过没有"，得是"画得够不够"——
   * 拆了几个小问，就该有大致同等数量的板书笔迹，一问一笔那种敷衍
   * 不能算数。
   */
  const needDraws = Math.max(2, Math.ceil(t.outline.length / 2));
  if (t.drawCount < needDraws) {
    return err(
      `这场辅导只画了 ${t.drawCount} 笔，跟 ${t.outline.length} 个小问比起来太少了——像是应付门槛，不是真的板书`,
      '像老师上课写板书那样，讲一步写一步：公式、算式、图形、关键结果，' +
        '每讲完一个小问就用 canvas_create（annot 或 ai 层）留一笔——不是全程讲完' +
        '最后补一笔意思意思。高亮题面上已经有的文字不算，那是指读，不是画。',
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
