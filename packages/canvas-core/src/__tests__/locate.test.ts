import { describe, expect, it } from 'vitest';
import { locateInImage, locateInImages } from '../geometry.js';

/**
 * 位图里印着什么，Agent 看不见（没配视觉模型时完全看不见）。
 * 但"用户画的这条线落在图的哪一块"靠坐标就能算准——
 * 这组测试守的就是这个兜底能力，免得 Agent 又回一句"我看不到你标注的位置"。
 */

const IMG: [number, number, number, number] = [100, 200, 800, 400]; // x,y,w,h

describe('相对位图定位', () => {
  it('底部靠左的标注', () => {
    const r = locateInImage([150, 560, 200, 10], IMG, 'im1', '第3题原图')!;
    expect(r.text).toContain('下部');
    expect(r.text).toContain('靠左');
    expect(r.text).toContain('第3题原图');
  });

  it('顶部靠右的标注', () => {
    const r = locateInImage([800, 210, 60, 20], IMG, 'im1')!;
    expect(r.text).toContain('上部');
    expect(r.text).toContain('靠右');
  });

  it('正中的标注', () => {
    const r = locateInImage([460, 380, 80, 40], IMG, 'im1')!;
    expect(r.text).toContain('中部');
    expect(r.text).toContain('居中');
  });

  it('给出归一化范围，便于精确表述', () => {
    const r = locateInImage([100, 200, 400, 100], IMG, 'im1')!;
    expect(r.xRange).toEqual([0, 0.5]);
    expect(r.yRange).toEqual([0, 0.25]);
  });

  it('超出图片的部分会被裁到 0~1', () => {
    const r = locateInImage([-500, -500, 5000, 5000], IMG, 'im1')!;
    expect(r.xRange).toEqual([0, 1]);
    expect(r.yRange).toEqual([0, 1]);
  });

  it('完全不相交时返回 null', () => {
    expect(locateInImage([5000, 5000, 10, 10], IMG, 'im1')).toBeNull();
  });

  it('零尺寸图片不参与定位', () => {
    expect(locateInImage([0, 0, 10, 10], [0, 0, 0, 0], 'bad')).toBeNull();
  });

  it('跨多张图片时逐一定位', () => {
    const hits = locateInImages(
      [150, 250, 900, 50],
      [
        { id: 'a', bounds: [100, 200, 400, 400], label: '题1' },
        { id: 'b', bounds: [600, 200, 400, 400], label: '题2' },
        { id: 'c', bounds: [100, 900, 400, 400], label: '题3' },
      ],
    );
    expect(hits.map((h) => h.imageId)).toEqual(['a', 'b']); // c 不相交
  });
});
