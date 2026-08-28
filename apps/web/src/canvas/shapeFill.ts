/**
 * 真机录像复现过："给答案画个框"变成了"把答案涂黑擦掉"——AI 正确地传了
 * fill:'none'（SVG 语义里"不填充"），但 Konva 底层是 Canvas 2D 的
 * fillStyle，只认得真正的颜色值；赋值一个它解析不了的字符串会静默
 * 失败，fillStyle 停留在画布默认色——黑色。SVG 渲染（canvas_snapshot、
 * 导出）走的是真正的 SVG 属性，`fill="none"` 本来就合法，所以那条路
 * 一直没暴露这个问题，只有真人在浏览器里看到的画面才会中招。
 *
 * 独立成文件是因为它不该依赖 react-konva——测试这个纯字符串转换逻辑
 * 不需要真的拉起 Konva 的渲染栈。
 */
export function resolveFill(fill: string | undefined): string | undefined {
  return fill && fill !== 'none' && fill !== 'transparent' ? fill : undefined;
}
