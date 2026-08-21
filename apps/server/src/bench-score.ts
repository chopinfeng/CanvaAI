/**
 * 读题基准的打分逻辑。
 *
 * 单独拎出来是为了能测。这段代码决定"视觉模型到底行不行"这个结论——
 * 它自己错了的话，给出的是一个理直气壮的错误判断，比没有基准更糟。
 */

export interface Extracted {
  statement?: string;
  known?: Record<string, unknown>;
  asks?: string[];
  topic?: string;
}

export interface Truth {
  id: string;
  topic: string;
  statement: string;
  /**
   * 扫描件左上角印的题号。
   *
   * 它是图上**真有**的内容，模型把它读出来是读对了不是编的。
   * 早先没算进 truth，于是 U2/U3/U4 全被判成"编了 28/29/30"——
   * 三个连号，一眼就该看出是题号而不是幻觉。
   */
  serial?: number;
  /** 已知量。值可能是数也可能是 '60°' 这类带单位的字符串，按原样比对 */
  known?: Record<string, string | number>;
  answer?: string;
}

export interface Score {
  id: string;
  ok: boolean;
  knownHit: number;
  knownTotal: number;
  /**
   * 丢了哪几个数。
   *
   * 只记总分的话，事后完全没法判断一次失分是"模型真读错了"还是
   * "我的指标算错了"——这两者要采取的行动完全相反。第一版基准
   * 就是因为没记这个，我盯着 0/5 全对的分数查了半天才发现是自己的锅。
   */
  missed?: string[];
  asksHit: boolean;
  topicHit: boolean;
  hallucinated: string[];
  note?: string;
}

/**
 * 从模型返回里抠出 JSON。
 *
 * 模型很少老老实实只回一个 JSON：常见的是裹在 ```json 里，
 * 或者前面加一句"好的，我看到这张图片包含："。这两种都得能接住，
 * 否则会把"读得挺准但格式啰嗦"误判成"完全读不出来"。
 */
export function parseJson(text: string): Extracted | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1]! : text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Extracted;
  } catch {
    return null;
  }
}

/**
 * 上下标数字转成普通数字。
 *
 * ∫₀¹ 里的 ₀ ¹、aₙ 里的下标、x² 里的 ² 都是独立的 Unicode 字符，
 * `\d` 一个都匹配不到。不转的话「计算定积分 ∫₀¹ x·eˣ dx」被算成
 * **一个数都没有**，于是这道题 0/0 无条件满分——本科那一档的分数
 * 就是这么虚高上去的。测出来的东西自己知道有问题，就得先修再报。
 */
const SUB = '₀₁₂₃₄₅₆₇₈₉';
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
function normalizeDigits(s: string): string {
  let out = '';
  let prev: 'sub' | 'sup' | null = null;
  for (const ch of s) {
    const i = SUB.indexOf(ch);
    const j = SUP.indexOf(ch);
    const cls = i >= 0 ? 'sub' : j >= 0 ? 'sup' : null;

    // 下标紧接上标（∫₀¹ 的积分限）是**两个**数，中间得断开——
    // 不断的话变成 "01"，0 和 1 都对不上了
    if (cls && prev && cls !== prev) out += ' ';
    out += cls ? String(i >= 0 ? i : j) : ch;
    prev = cls;
  }
  return out;
}

/**
 * 去掉题号：`(1)` `(2)` `27.` 这些是版面编号，不是题目内容。
 *
 * 这条是诊断跑出来的，占了全部失分的 **89%**：模型把题干正文读得
 * 一字不差，但按我的指令把两问放进了 `asks`，没把 `(1)(2)` 抄进 statement——
 * 然后我拿题干里的 1 和 2 去扣它的分。**我在惩罚它听我的话。**
 *
 * 只匹配括号里独占的一到两位数字：`(1, 2)` 这种坐标点带逗号，不会被误伤
 * （U5 的「在点 (1, 2) 处」就是这种）。
 */
export function stripNumbering(s: string): string {
  return s
    .replace(/[(（]\s*\d{1,2}\s*[)）]/g, ' ')
    .replace(/^\s*\d{1,2}\s*[.．、]/gm, ' ');
}

/** 比内容不比格式：去掉空格和常见标点差异 */
function loose(s: string): string {
  return normalizeDigits(s).replace(/[\s，,。．;；]/g, '');
}

/** 抓出文本里所有的数（含分数和小数，上下标也算） */
export function numbersIn(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of normalizeDigits(s).matchAll(/\d+(?:\.\d+)?(?:\/\d+)?/g)) out.add(m[0]);
  return out;
}

export function score(p: Truth, got: Extracted | null, rawLen = 0): Score {
  const knownTotal = numbersIn(stripNumbering(p.statement)).size;

  if (!got) {
    return {
      id: p.id,
      ok: false,
      knownHit: 0,
      knownTotal,
      asksHit: false,
      topicHit: false,
      hallucinated: [],
      note: `没能解析出 JSON（返回 ${rawLen} 字）`,
    };
  }

  const flat = JSON.stringify(got);

  /**
   * 数值保真：题干里出现的数，模型有没有原样读出来。
   *
   * 早先这里比的是 `known` 字典——结果测的是"模型猜不猜得中我起的中文键名"。
   * 实测 U5 模型把题干一字不差读了下来（∂ 符号都对），却因为它写
   * {"x":1,"y":2} 而我写 {"f(x,y)":...,"点":...} 被判 0/2。那是我的指标坏了。
   *
   * 现在只比数：题干是扫描件上真实印着的内容，里面的每个数模型都该读出来。
   * 这才是"读得准不准"。至于它把条件归到哪个键名下，是格式偏好，不是能力。
   */
  const wantNums = [...numbersIn(stripNumbering(p.statement))].filter((x) => x !== String(p.serial));
  const gotBlob = `${got.statement ?? ''} ${JSON.stringify(got.known ?? {})} ${(got.asks ?? []).join(' ')}`;
  const gotSet = numbersIn(gotBlob);
  const missed = wantNums.filter((x) => !gotSet.has(x));
  let hit = wantNums.length - missed.length;
  const knownTotal2 = wantNums.length;

  /**
   * 另外：模型**明确声明**了某个已知量却写错值的，直接算一次失分。
   * 下游 Agent 读的是这个结构化字段，那里给了错值就是错值。
   */
  for (const [name, want] of Object.entries(p.known ?? {})) {
    const declared = got.known !== undefined && got.known[name] !== undefined;
    if (!declared) continue;
    // 只为"值真的不一样"扣分，不为空格和写法差异扣。
    // 模型写 [[2, 1], [1, 2]]、我写 [[2,1],[1,2]]，内容完全相同——
    // 这是我在主指标上已经修过一次的错（比格式不比内容），扣分这条路上还留着。
    if (loose(String(got.known![name])) !== loose(String(want))) hit = Math.max(0, hit - 1);
  }

  /**
   * 所求：模型有没有把"问什么"抓出来。
   *
   * 早先是从**参考答案**里抽大写字母串，要求模型复现——错在答案里会出现
   * 解题过程用的辅助量。G8 的答案提到 ∠AOD（辅助角），题目根本没问它，
   * 于是模型把两问都答对了还被判"没识别出所求"。
   *
   * 现在改成看它抄回来的问句和原题的问句对不对得上：把题干里 (1) 之后
   * 的部分当作"问什么"，模型的 asks 只要有一条能对上就算。
   */
  const qPart = loose((p.statement.match(/[(（]\s*1\s*[)）][\s\S]*/) ?? [''])[0]);
  const asksHit =
    qPart.length === 0 ||
    (got.asks ?? []).some((a) => {
      const key = loose(a);
      return key.length >= 4 && qPart.includes(key.slice(0, Math.min(8, key.length)));
    }) ||
    loose(got.statement ?? '').includes(qPart.slice(0, 10));

  /* ---- 考点：软匹配，说法可以不同 ---- */
  const topicWords = p.topic.split(/[\s/·、]+/).filter((w) => w.length >= 2);
  const topicHit = topicWords.some((w) => flat.includes(w));

  /**
   * 幻觉：提取里出现、而 ground truth 里压根没有的数。
   *
   * 排除 ≤2 的小数：那多半是题号和 (1)(2) 这种序号，不是题目条件。
   * 这条是整个基准里最要紧的指标——辅导时读错一个数，
   * 后面整场推导都建在错的前提上，而模型每一步都理直气壮。
   */
  const truthNums = numbersIn(
    `${p.statement} ${JSON.stringify(p.known ?? {})} ${p.answer ?? ''} ${p.serial ?? ''}`,
  );
  const gotNums = [...numbersIn(`${got.statement ?? ''} ${JSON.stringify(got.known ?? {})}`)];
  const hallucinated = gotNums.filter((n) => !truthNums.has(n) && Number(n) > 2);

  return {
    id: p.id,
    ok: hit === knownTotal2 && asksHit && hallucinated.length === 0,
    knownHit: hit,
    knownTotal: knownTotal2,
    ...(missed.length > 0 ? { missed } : {}),
    asksHit,
    topicHit,
    hallucinated,
  };
}
