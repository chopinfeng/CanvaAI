import type { Scene } from '@canvai/canvas-core';
import type { ServerMessage, ShapeInput } from '@canvai/protocol';
import { parseJson } from './bench-score.ts';
import { makeVisionProvider, type VisionCreds } from './vision.ts';
import { readAsset } from './assets.ts';
import { log } from './log.ts';

/**
 * 把一张上传的试卷图转成画布上的题目。
 *
 * 这条路是读题基准验出来能走通之后才敢做的：实测 Kimi K3 在 31 道题上
 * 数值保真 99%、**一次数字都没编**。没有那份基准，这个功能就是
 * "看起来能用"——而它一旦读错一个数，后面整场辅导都建在错的前提上。
 *
 * 布局刻意和 seed 脚本一致：左边原图、右边转换结果，并排放。
 * 用户能一眼核对转换对不对——**这一步不能省**，模型再准也有 1% 的时候，
 * 而错在哪里只有出题人自己看得出来。
 */

const LEFT_X = 80;
const IMG_W = 760;
const RIGHT_X = 900;
const RIGHT_W = 620;
const INK = '#1c1917';
const MUTED = '#78716c';
const ACCENT = '#2563eb';

/** 问模型的话。和基准里用的是同一套，那套已经在 31 道题上验过 */
const PROMPT = `这是一张试卷/作业的照片或扫描件。请**只提取你在图上看到的内容**，不要解题，不要补充图上没有的条件。

按这个 JSON 格式回答，不要有别的文字：
{
  "statement": "完整题干原文（含所有小问）",
  "known": { "量名": 数值 },
  "asks": ["第(1)问求什么", "第(2)问求什么"],
  "topic": "这道题的考点"
}

注意：
- known 只填题目**明确给出**的数值条件，不要填你推算出来的。
- 看不清的地方写 "?"，**不要猜**——猜错一个数，后面整道题都会跟着错。`;

export interface ImportResult {
  topic?: string;
  statement?: string;
  asks?: string[];
  shapeIds: string[];
}

/** PNG 尺寸直接读 IHDR，不必引入图片库 */
function pngSize(buf: Uint8Array): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // PNG magic
  if (dv.getUint32(0) !== 0x89504e47) return null;
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

/** Konva 的 Text 不自动折行，按字宽估算手动折 */
function wrap(text: string, maxWidth: number, fontSize: number): string {
  const perLine = Math.floor(maxWidth / fontSize);
  return text
    .split('\n')
    .map((para) => {
      const out: string[] = [];
      let cur = '';
      let units = 0;
      for (const ch of para) {
        const w = ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55;
        if (units + w > perLine) {
          out.push(cur);
          cur = '';
          units = 0;
        }
        cur += ch;
        units += w;
      }
      if (cur) out.push(cur);
      return out.join('\n');
    })
    .join('\n');
}

const lines = (s: string) => s.split('\n').length;

export async function importPaper(
  scene: Scene,
  assetId: string,
  creds: VisionCreds,
  emit: (m: ServerMessage) => void,
): Promise<ImportResult | null> {
  const asset = await readAsset(assetId);
  if (!asset) {
    emit({ t: 'paper.progress', phase: 'failed', message: '这张图找不到了，重新上传一次试试。' });
    return null;
  }

  emit({ t: 'paper.progress', phase: 'reading', message: '正在读这张试卷…' });

  let extracted;
  try {
    /**
     * 重试两次。视觉模型偶发返回空内容（实测三十次里一两次），
     * 那时候让用户重新上传一遍是很糟的体验——他没做错任何事。
     */
    let raw = '';
    for (let i = 0; i < 3; i++) {
      raw = await makeVisionProvider(creds).describe(asset.bytes, PROMPT);
      if (parseJson(raw)) break;
    }
    extracted = parseJson(raw);
    if (!extracted?.statement) throw new Error('模型没能读出题干');
  } catch (e) {
    const msg = (e as Error).message;
    log.error('paper.read_failed', { assetId, message: msg });
    emit({
      t: 'paper.progress',
      phase: 'failed',
      // 把最常见的原因直说，别让用户对着一句"失败了"猜
      message: /401|403|invalid/i.test(msg)
        ? 'API Key 不对或没权限，去右上角「视觉模型」里检查一下。'
        : `没能读出这张图：${msg.slice(0, 60)}`,
    });
    return null;
  }

  emit({ t: 'paper.progress', phase: 'placing', message: '读出来了，正在放到画布上…' });

  /* ---- 放到画布上：左原图、右转换结果 ---- */
  const size = pngSize(asset.bytes);
  const imgH = size ? Math.round((size.h * IMG_W) / size.w) : 500;

  // 从现有内容下方接着放，别盖在用户已有的东西上
  const bounds = scene.contentBounds();
  const top = scene.size > 0 ? bounds[1] + bounds[3] + 80 : 80;

  const shapes: ShapeInput[] = [];
  const t = (x: number, y: number, s: string, size: number, color = INK, role = 'text'): ShapeInput => ({
    type: 'text',
    x,
    y,
    text: s,
    style: { stroke: color, fontSize: size },
    meta: { role },
  });

  shapes.push(t(LEFT_X, top, `${extracted.topic ?? '导入的题目'}（自动识别）`, 19, ACCENT, 'problem-title'));

  const bodyTop = top + 38;
  shapes.push(t(LEFT_X, bodyTop, '你上传的原图', 13, MUTED, 'section-label'));
  shapes.push({
    type: 'image',
    x: LEFT_X,
    y: bodyTop + 22,
    w: IMG_W,
    h: imgH,
    assetId,
    meta: { role: 'source-image', label: '上传的试卷' },
  });

  shapes.push(t(RIGHT_X, bodyTop, '识别结果（请核对）', 13, MUTED, 'section-label'));

  const stmt = wrap(extracted.statement, RIGHT_W, 15);
  shapes.push(t(RIGHT_X, bodyTop + 22, stmt, 15, INK, 'statement'));
  let y = bodyTop + 22 + lines(stmt) * 15 * 1.4;

  const known = extracted.known ?? {};
  if (Object.keys(known).length > 0) {
    const kv = Object.entries(known)
      .map(([k, v]) => `${k} = ${String(v)}`)
      .join('　');
    const w = wrap(`已知：${kv}`, RIGHT_W, 14);
    shapes.push(t(RIGHT_X, y + 12, w, 14, '#059669', 'known'));
    y += 12 + lines(w) * 14 * 1.4;
  }

  if (extracted.asks && extracted.asks.length > 0) {
    const w = wrap(extracted.asks.map((a, i) => `(${i + 1}) ${a}`).join('\n'), RIGHT_W, 14);
    shapes.push(t(RIGHT_X, y + 12, w, 14, INK, 'asks'));
    y += 12 + lines(w) * 14 * 1.4;
  }

  /**
   * 明写一句"请核对"。
   *
   * 模型读错一个数，后面整场辅导都建在错的前提上，而它每一步都理直气壮。
   * 基准上是 99%——那也意味着一百道里有一道是错的，而错在哪儿
   * 只有拿着原卷的人看得出来。所以这句提示不是客套。
   */
  shapes.push(
    t(RIGHT_X, y + 16, '⚠ 自动识别的结果，开始做题前请对着左边原图核对一遍数值。', 12.5, '#b45309', 'verify-hint'),
  );

  const { ids } = scene.create(shapes, {
    author: { id: 'import', kind: 'user', name: '导入' },
    layer: 'user',
  });

  log.info('paper.imported', { assetId, shapes: ids.length, topic: extracted.topic });
  const result: ImportResult = {
    shapeIds: ids,
    ...(extracted.topic ? { topic: extracted.topic } : {}),
    ...(extracted.statement ? { statement: extracted.statement } : {}),
    ...(extracted.asks ? { asks: extracted.asks } : {}),
  };
  emit({ t: 'paper.progress', phase: 'done', message: '转换好了，请核对一下数值。', result });
  return result;
}
