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
  /** 已知量。值可能是数也可能是 '60°' 这类带单位的字符串，按原样比对 */
  known?: Record<string, string | number>;
  answer?: string;
}

export interface Score {
  id: string;
  ok: boolean;
  knownHit: number;
  knownTotal: number;
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

/** 抓出文本里所有的数（含分数和小数） */
export function numbersIn(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/\d+(?:\.\d+)?(?:\/\d+)?/g)) out.add(m[0]);
  return out;
}

export function score(p: Truth, got: Extracted | null, rawLen = 0): Score {
  const knownTotal = Object.keys(p.known ?? {}).length;

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

  /* ---- 已知量：名字和数值都要对上 ---- */
  const known = p.known ?? {};
  let hit = 0;
  for (const name of Object.keys(known)) {
    const want = String(known[name]);
    // 模型可能填进 known 对象，也可能只写在 statement 里的 "AB=13"，两种都认
    const inKnown = got.known !== undefined && String(got.known[name] ?? '') === want;
    const inText = new RegExp(`${name}\\s*[=＝]\\s*${want}(?!\\d)`).test(flat);
    if (inKnown || inText) hit++;
  }

  /* ---- 所求：答案里出现的量名，得在 asks 或题干里被提到 ---- */
  const askedFor = (p.answer ?? '').match(/[A-Z]{2,}/g) ?? [];
  const asksText = `${(got.asks ?? []).join(' ')} ${got.statement ?? ''}`;
  const asksHit = askedFor.length === 0 || askedFor.some((a) => asksText.includes(a));

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
  const truthNums = numbersIn(`${p.statement} ${JSON.stringify(known)} ${p.answer ?? ''}`);
  const gotNums = [...numbersIn(`${got.statement ?? ''} ${JSON.stringify(got.known ?? {})}`)];
  const hallucinated = gotNums.filter((n) => !truthNums.has(n) && Number(n) > 2);

  return {
    id: p.id,
    ok: hit === knownTotal && asksHit && hallucinated.length === 0,
    knownHit: hit,
    knownTotal,
    asksHit,
    topicHit,
    hallucinated,
  };
}
