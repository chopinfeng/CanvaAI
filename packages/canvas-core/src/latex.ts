import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import 'mathjax-full/js/input/tex/base/BaseConfiguration.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';
import 'mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js';
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import 'mathjax-full/js/input/tex/noerrors/NoErrorsConfiguration.js';
import 'mathjax-full/js/input/tex/color/ColorConfiguration.js';
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration.js';

/**
 * LaTeX 源码 -> SVG。
 *
 * 用 MathJax 而不是 KaTeX：KaTeX 整段公式排版靠 HTML + 专用字体（KaTeX_Main 等），
 * 搬到 Konva 画布或拼进服务端的 SVG 字符串前，得先把字体嵌进去、再用
 * foreignObject 转成图片——各浏览器对 foreignObject 光栅化的行为不一致，
 * 边界情况很难保证一致。MathJax 的 SVG 输出模式（fontCache: 'none'）
 * 直接把每个字形展开成 <path>，不依赖任何外部字体/CSS，生成的字符串本身
 * 就是自洽的矢量图形，服务端可以直接拼进已有的 SVG 文档，前端转成
 * data URI 扔进 Konva Image 也不会有跨浏览器的光栅化差异。
 *
 * 流水线只搭一次：adaptor/inputJax/outputJax/document 都是有状态的重对象，
 * 每次调用都重建的话，光初始化就比排版本身贵得多。convert() 是独立的
 * 一次性转换入口，不会把结果挂进 document 的 math 列表，重复调用不会
 * 造成状态堆积。
 */
const PACKAGES = ['base', 'ams', 'newcommand', 'noundefined', 'boldsymbol', 'noerrors', 'color', 'cancel'];

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const texInput = new TeX({ packages: PACKAGES });
const svgOutput = new SVG({ fontCache: 'none' });
const doc = mathjax.document('', { InputJax: texInput, OutputJax: svgOutput });

export interface LatexRender {
  /** 自洽的 <svg ...>...</svg> 字符串，width/height 已经换算成 px */
  svg: string;
  width: number;
  height: number;
}

export interface LatexError {
  error: string;
}

/**
 * fontSize 决定 ex 换算：MathJax 原生按 ex 度量出图，这里固定 1ex = fontSize/2
 * （MathJax 自己在没有真实字体量出的场景下也是用这个近似值），换算成 px 后
 * 直接写回根 <svg> 的 width/height，调用方不用再处理单位。
 *
 * color 写进根 <svg> 的 color 属性：MathJax 的路径都用 fill="currentColor"，
 * 靠这个属性继承实际颜色。客户端会把整份 SVG 转成独立的 data URI 光栅化，
 * 脱离了原来的 DOM 层叠上下文，不显式写这一步的话颜色就只能退回黑色。
 */
export function renderLatexToSvg(tex: string, fontSize = 16, color = '#111827'): LatexRender | LatexError {
  const trimmed = tex.trim();
  if (!trimmed) return { error: '空公式' };

  try {
    const exPx = fontSize / 2;
    const node = doc.convert(trimmed, {
      display: true,
      em: fontSize,
      ex: exPx,
      containerWidth: 80 * fontSize,
    });
    const raw = adaptor.innerHTML(node);

    /**
     * noerrors 包不抛异常，而是把解析失败的部分包成 <merror> 内嵌渲染——
     * 但那个错误框的背景矩形和文字都吃同一个 currentColor，没有 MathJax 自带
     * 的错误态 CSS（我们完全不带外部样式表），背景和文字同色，糊成一块
     * 看不出内容的实心色块。这种情况直接当错误处理，退化成纯文本更可读。
     */
    const mjxError = /data-mjx-error="([^"]*)"/.exec(raw)?.[1];
    if (mjxError) return { error: mjxError };

    const widthEx = parseFloat(/\swidth="([\d.]+)ex"/.exec(raw)?.[1] ?? '0');
    const heightEx = parseFloat(/\sheight="([\d.]+)ex"/.exec(raw)?.[1] ?? '0');
    const width = widthEx * exPx;
    const height = heightEx * exPx;

    if (!(width > 0) || !(height > 0)) return { error: 'MathJax 没能排出有效尺寸' };

    const svg = raw
      .replace(/\swidth="[\d.]+ex"/, ` width="${width}"`)
      .replace(/\sheight="[\d.]+ex"/, ` height="${height}"`)
      .replace(/^<svg /, `<svg color="${color}" `);

    return { svg, width, height };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function isLatexError(r: LatexRender | LatexError): r is LatexError {
  return 'error' in r;
}
