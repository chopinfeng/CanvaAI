import { describe, expect, it } from 'vitest';
import { Scene, sceneToSvg } from '@canvai/canvas-core';
import { RenderError, initRasterizer } from '../rasterizer.ts';

/**
 * 这组测试守的是一次真实事故：
 * canvas_snapshot 截一小块区域 → resvg（Rust）panic → abort 整个进程 →
 * 所有人的画布连接一起断掉，终端只剩 vite 的 ECONNREFUSED 刷屏。
 *
 * 触发条件是 marker-end 或 opacity<1 的元素整个落在 viewBox 之外。
 * 现在两道防线：SVG 生成时裁掉视口外的图元，渲染跑在独立子进程里。
 *
 * 如果隔离失效，下面这些用例不会"失败"——它们会**带着整个测试进程一起消失**。
 */

const USER = { id: 'u1', kind: 'user' as const };

/** 复刻事故现场：图元都在远处，只截左上角一小块 */
function sceneWithFarShapes(): Scene {
  const scene = new Scene();
  scene.create(
    [
      { type: 'rect', x: 320, y: 384, w: 208, h: 160 },
      // 带箭头 marker，远离截图区域
      { type: 'arrow', points: [[900, 560], [1100, 560]], meta: { role: 'axis-x' } },
      { type: 'arrow', points: [[900, 560], [900, 400]], meta: { role: 'axis-y' } },
      // 半透明多边形，同样在远处
      {
        type: 'polygon',
        points: [[992, 762], [1100, 700], [1050, 800]],
        closed: true,
        style: { stroke: '#e05a5a', strokeWidth: 2, fill: '#e05a5a', opacity: 0.25 },
        meta: { role: 'plane' },
      },
    ],
    { author: USER },
  );
  return scene;
}

describe('SVG 生成：视口外的图元不该进 SVG', () => {
  it('小区域截图只保留相交的图元', () => {
    const scene = sceneWithFarShapes();
    const svg = sceneToSvg(scene.all(), { region: [320, 384, 20, 20], scale: 1 });

    // 远处那些是 panic 的来源，必须被裁掉
    expect(svg).not.toContain('marker-end');
    expect(svg).not.toContain('opacity="0.25"');
    // 视口内的矩形要留着
    expect(svg).toContain('<rect x="320" y="384"');
  });

  it('整图截图仍然包含全部图元', () => {
    const scene = sceneWithFarShapes();
    const svg = sceneToSvg(scene.all(), {});
    expect(svg).toContain('marker-end');
    expect(svg).toContain('opacity="0.25"');
  });

  it('箭头的 defs 只出现一次（同 id 重复是非法 SVG）', () => {
    const scene = sceneWithFarShapes();
    const svg = sceneToSvg(scene.all(), {});
    expect(svg.split('id="arrowhead"').length - 1).toBe(1);
  });
});

describe('渲染隔离：原生崩溃不能带走服务端', () => {
  it('故意构造会让 resvg panic 的 SVG，只失败不崩进程', async () => {
    const raster = await initRasterizer();
    if (!raster) {
      // 没装 resvg 时这条无从验证，但降级路径本身有独立测试
      expect(raster).toBeUndefined();
      return;
    }

    // 直接绕过裁剪，手写事故 SVG：marker-end 的路径完全在 viewBox 之外
    const evil =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="320 384 20 20">' +
      '<rect x="320" y="384" width="20" height="20" fill="#fff"/>' +
      '<defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">' +
      '<polygon points="0 0, 10 3.5, 0 7" fill="currentColor"/></marker></defs>' +
      '<path d="M 900 560 L 1100 560" stroke="#000" stroke-width="2" fill="none" marker-end="url(#arrowhead)"/>' +
      '</svg>';

    await expect(raster.render(evil, 1)).rejects.toBeInstanceOf(RenderError);
    // 关键：跑到这里说明测试进程还活着
    expect(true).toBe(true);
  }, 30_000);

  it('正常 SVG 照常渲染出 PNG', async () => {
    const raster = await initRasterizer();
    if (!raster) return;

    const scene = sceneWithFarShapes();
    const png = await raster.render(sceneToSvg(scene.all(), {}), 1);
    expect(png.length).toBeGreaterThan(100);
    // PNG magic number
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 30_000);

  it('超大目标图像被拦下，而不是把内存吃光', async () => {
    const raster = await initRasterizer();
    if (!raster) return;

    const huge = '<svg xmlns="http://www.w3.org/2000/svg" width="30000" height="30000" viewBox="0 0 30000 30000"></svg>';
    await expect(raster.render(huge, 1)).rejects.toThrow(/太大/);
  });
});
