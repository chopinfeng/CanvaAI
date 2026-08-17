import type { Rasterizer } from '@canvai/agent';

/**
 * SVG → PNG。
 *
 * resvg 是可选依赖：没装也不影响画布和 Agent 主流程，
 * 只是 canvas_snapshot 会退化成结构化描述（见 execSnapshot）。
 * 大多数情况下结构化描述反而更准，所以这个降级是可以接受的。
 */

let cached: Rasterizer | undefined;
let initialized = false;

export async function initRasterizer(): Promise<Rasterizer | undefined> {
  if (initialized) return cached;
  initialized = true;

  try {
    const mod = (await import('@resvg/resvg-js')) as {
      Resvg: new (svg: string, opts?: unknown) => { render(): { asPng(): Buffer } };
    };
    cached = {
      async render(svg: string, scale: number): Promise<Uint8Array> {
        const resvg = new mod.Resvg(svg, { fitTo: { mode: 'zoom', value: scale } });
        return new Uint8Array(resvg.render().asPng());
      },
    };
    console.log('[rasterizer] resvg 已就绪，canvas_snapshot 可输出图片');
  } catch {
    console.log('[rasterizer] 未安装 @resvg/resvg-js，canvas_snapshot 将退化为结构化描述');
    cached = undefined;
  }
  return cached;
}

export const getRasterizer = (): Rasterizer | undefined => cached;
