import { locateInImages, round, shapeBounds, unionBounds } from '@canvai/canvas-core';
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

    /**
     * 题目原文（画布上 role=statement 的图元）直接摆出来，不等模型自己去查。
     *
     * 真机复现过：用户开口只说"给我讲这道题"，画布概况这里只报得出
     * "4 个图元"这种数量，没有内容。模型没有主动去 canvas_query/
     * canvas_snapshot 看题，就凭空编了一个典型的阻尼振动方程往下讲，
     * 甚至把提示词里"拆题示例"那句话里的"求 BD 和 DC""求内切圆半径 r"
     * （纯粹是教怎么写条目措辞的例子，跟任何真实题目无关）当成了题目
     * 本身问出来。一整场 tutor_plan 被迫重来了 6 次，20 分钟里题目
     * 内容换了三四轮，一笔画布都没落。跟 kg_lookup 那道闸一样的道理：
     * 拆题这种"要不要主动去看"的事，靠模型自觉最终会有一次不做。
     * 试卷导入（paper.ts）和这里的种题脚本都用这个 role 标真题干，
     * 直接摆出来，模型就不必也不会去凭空猜。
     */
    const stmt = scene
      .all()
      .filter((s) => s.meta.role === 'statement' && s.text)
      .map((s) => s.text!.replace(/\n+/g, ' '))
      .join(' / ');
    if (stmt) lines.push(`  [画布上的题目原文] ${stmt.slice(0, 400)}`);

    /**
     * 题目自带的图形（三角形、坐标系这类矢量图）由哪些图元组成、
     * 各自的 id 是什么，直接摆出来，不等模型自己去查。
     *
     * 真机复现过一个比"没标注图形"更具体的病灶：一道自带三角形的题，
     * 模型想 canvas_highlight 讲到的那条边，却编了个 "triangle_ABC" 这样
     * "听起来该有"的 id 去调——画布上从来没有这个 id（种题脚本没手动
     * 指定 id，全是自动生成的随机串），一次次失败，连着报了五次同一个
     * 错，模型甚至反过来问学生"你能指出三角形 ABC 的位置吗"，最后
     * 空转到超时收场，一整场没在图上标过一笔。根子不是它不想标注，
     * 是它压根不知道每条边、每个点的真实 id，只能猜一个语义上"应该"
     * 存在的名字。种题脚本已经给每个图元标了 role（side-AB、altitude-AD、
     * vertex 等），跟摆题目原文是同一个道理：能报给它的真实 id，不该
     * 让它自己猜。
     */
    const diagramShapes = scene.all().filter((s) => s.layer === 'user' && s.type !== 'text' && s.type !== 'latex');
    if (diagramShapes.length > 0) {
      const labels = scene.all().filter((s) => s.layer === 'user' && (s.type === 'text' || s.type === 'latex') && s.meta.role !== 'statement' && s.meta.role !== 'problem-title' && s.meta.role !== 'section-label' && s.meta.role !== 'hint');
      const parts = [...diagramShapes, ...labels]
        .slice(0, 24)
        .map((s) => `${s.id}(${s.meta.role ?? s.type}${s.text ? `,"${s.text}"` : ''})`);
      lines.push(`  [题目上的图形图元] ${parts.join(' ')}`);
    }

    /**
     * 板书区一开始该从哪儿写，真机复现过撞车：第一笔往往贴着题目写
     * （比如直接写在题干正下方几十像素处），结果压住了题目标题或题干
     * 本身，canvas_create 被碰撞检测拒了。提示词里让它"右侧或下方留
     * 一块空白"，但那是抽象的方向感，不是坐标——第一笔落在哪儿之前，
     * 它手上没有任何具体数字，只能瞎猜。这里用 user 层（题目原本的内容）
     * 的包围盒算出一个具体的起笔点，跟摆题目原文是同一个道理：
     * 能算出来的事实不该让模型自己猜。只在还没有任何 ai/annot 图元时
     * 提示——板书一旦起了头，接下来往哪儿接该靠 canvas_snapshot
     * 实地看一眼，不能再靠这里算出来的静态坐标，那样会重犯"算出来的
     * 坐标看着没问题、实际排版对不上"的老毛病。
     *
     * 这个起笔点上线之后又暴露了下一层问题：用户直接在真实画布里点出来
     * 问"为什么右侧都是一片空白"——题目原文本身是一条窄栏（用户层内容
     * 常常没多宽），起笔点的 x 直接抄了题目的左边界，模型于是把整场
     * 板书都续成了同一条又窄又长的竖列，用户的视口（默认 1440 宽）
     * 右边大半块地方全程没碰过。只给起笔坐标不够，还得把"这块空白
     * 到底有多宽"这个事实也算给它——不然它没法知道题目窄不代表板书
     * 也该窄。
     */
    const boardStarted = scene.all().some((s) => s.layer === 'ai' || s.layer === 'annot');
    if (!boardStarted) {
      const given = scene.all().filter((s) => s.layer === 'user');
      if (given.length > 0) {
        const gb = unionBounds(given.map(shapeBounds));
        const startX = Math.round(gb[0]);
        const startY = Math.round(gb[1] + gb[3] + 80);
        const usableWidth = Math.max(Math.round(gb[2]), Math.round(session.viewport[0] + session.viewport[2] - startX - 80));

        /**
         * 题目自带真图形（三角形、坐标系这类矢量图，不是纯文字题干）时，
         * "往下写一列字"这条建议本身就是错的方向——真机复现过：一道
         * 自带三角形矢量图的几何题，板书按这条建议续成了一条竖列，
         * 跟三角形隔着一大片空白，从头到尾没在图上标过一笔，用户在
         * 真实画布里点开一看，"图和字完全是两个世界"。给图形单独算
         * 一个包围盒、单独提一句——不能让"往下留白"这条通用建议
         * 把有图的题目也带偏成纯文字列表。
         */
        const givenDiagram = given.filter((s) => s.type !== 'text' && s.type !== 'latex');
        if (givenDiagram.length > 0) {
          const db = unionBounds(givenDiagram.map(shapeBounds));
          lines.push(
            `  ⚠ 板书区还没定下来，题目自带一个图形，范围是 ${fmtRect(db)}——` +
              '这道题的板书不该是一列跟图形没关系的文字。先用 canvas_create 在这个图形本身附近真的' +
              '落一笔（贴着某条边写上求出的长度、在顶点旁标一个角度、用一小段彩色 line 描出正在' +
              '讨论的那条边）——canvas_highlight 只是让图元短暂发光，不创建新图元，不算真的标注过。' +
              `文字推导可以另起一块（比如从 (${startX}, ${startY}) 开始，这块空白约 ${usableWidth} ` +
              '像素宽，不用挤成窄列），但图形本身必须被真的画过一笔，不是隔着一大片空白各写各的。',
          );
        } else {
          lines.push(
            `  ⚠ 板书区还没定下来。题目内容范围是 ${fmtRect(gb)}——建议板书区从 (${startX}, ${startY}) 开始往下写，` +
              `这是题目正下方最大的一块空白，别贴着题目写。这块空白足有约 ${usableWidth} 像素宽——` +
              '题目原文窄，不代表板书也得挤成一条窄列：公式、算式可以写得舒展些，示意图可以摆在' +
              '推导过程旁边，不用把每一步都摞成又窄又长的一条竖线。定下之后，后续每一笔该往哪儿接，' +
              '用 canvas_snapshot 实地看，不要照这个起笔点自己往下推算。',
          );
        }
      }
    }

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
