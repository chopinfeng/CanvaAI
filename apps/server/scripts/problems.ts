import type { ShapeInput } from '@canvai/protocol';
import { buildFigure } from './figure.ts';
import * as F from './figures.ts';

/**
 * 演示与回归用的题库。
 *
 * **题目全部为本项目自编**，不取自任何教辅或试卷汇编。用的都是教科书里
 * 人人都在用的经典构型（矩形折叠、等腰三角形、平行截线、二次函数……），
 * 数值和问法是自己拟的，每一步答案都在 `src/__tests__/figures.test.ts` 里验算过。
 *
 * 每道题两份内容并排放进画布：
 *   - 原图：一张"扫描件"（由 make-mock-scans.ts 渲染，模拟纸质试卷）
 *   - 转换结果：题干文本（+ 部分题目的矢量化图形）
 * 左右对照是为了让"转换得对不对"肉眼可核。
 *
 * figure 只在图形能由题给条件唯一确定时才给。确定不了就诚实留空并写明原因
 * （figureNote）——硬画一个走样的图比没有图更糟，Agent 会拿它当真去测量。
 */

export interface Problem {
  id: string;
  /** 考点 */
  topic: string;
  /** 难度，便于挑题 */
  level: '基础' | '中等' | '较难';
  /** 模拟扫描件文件名（由 make-mock-scans.ts 生成到 .work/crops/） */
  image: string;
  /** 题干 */
  statement: string;
  /** 矢量化图形。相对坐标，注入时会整体平移到卡片位置 */
  figure?: (origin: { x: number; y: number }) => ShapeInput[];
  /** 没有矢量化时说明原因——判断依据要留在代码里，不能只靠记忆 */
  figureNote?: string;
  /** 已知条件的结构化表达，供 Agent 直接查询 */
  known?: Record<string, string | number>;
  /** 参考答案，仅用于测试断言；辅导模式下不会展示给用户 */
  answer?: string;
}

export const PROBLEMS: Problem[] = [
  {
    id: 'G1',
    topic: '矩形折叠 / 勾股定理',
    level: '中等',
    image: 'G1.png',
    statement:
      '矩形 ABCD 中，AB=13，AD=5。点 E 在边 BC 上，将矩形沿直线 AE 翻折，点 B 落在点 F 处，且 F 恰好落在边 CD 上。\n' +
      '(1) 求 DF 与 FC 的长；\n' +
      '(2) 求线段 BE 的长。',
    known: { AB: 13, AD: 5 },
    answer: 'DF=12，FC=1；BE=13/5',
    figure: (o) => buildFigure(F.G1_FIG, o),
  },
  {
    id: 'G2',
    topic: '等腰三角形 / 面积与内切圆',
    level: '中等',
    image: 'G2.png',
    statement:
      '等腰三角形 ABC 中，AB=AC=13，BC=10。\n' +
      '(1) 求 BC 边上的高；\n' +
      '(2) 求△ABC 的面积；\n' +
      '(3) 求△ABC 内切圆的半径。',
    known: { AB: 13, AC: 13, BC: 10 },
    answer: '高=12；面积=60；内切圆半径 r=S/s=60/18=10/3',
    figure: (o) => buildFigure(F.G2_FIG, o),
  },
  {
    id: 'G3',
    topic: '直角梯形 / 勾股定理',
    level: '基础',
    image: 'G3.png',
    statement:
      '四边形 ABCD 中，AD∥BC，∠A=∠B=90°，AD=9，AB=8，BC=15。\n' +
      '(1) 求腰 CD 的长；\n' +
      '(2) 求该梯形的面积。',
    known: { AD: 9, AB: 8, BC: 15 },
    answer: 'CD=10；面积=(9+15)×8/2=96',
    figure: (o) => buildFigure(F.G3_FIG, o),
  },
  {
    id: 'G4',
    topic: '直角三角形 / 中位线',
    level: '基础',
    image: 'G4.png',
    statement:
      'Rt△ABC 中，∠C=90°，AC=12，BC=5。点 D、E 分别是 AB、AC 的中点，连接 DE。\n' +
      '(1) 求 AB 的长；\n' +
      '(2) 求 DE 的长，并说明理由。',
    known: { '∠C': '90°', AC: 12, BC: 5 },
    answer: 'AB=13；DE 是中位线，DE=BC/2=5/2',
    figure: (o) => buildFigure(F.G4_FIG, o),
  },
  {
    id: 'G5',
    topic: '等边三角形 / 全等',
    level: '较难',
    image: 'G5.png',
    statement:
      '等边△ABC 的边长为 8。点 E 在边 AC 上，点 D 在边 BC 上，且 AE=CD=3，AD 与 BE 交于点 F。\n' +
      '(1) 求证：AD=BE；\n' +
      '(2) 求 AD 的长；\n' +
      '(3) 求∠BFD 的度数。',
    known: { 边长: 8, AE: 3, CD: 3 },
    answer: '△ABE≌△CAD ⇒ AD=BE=7；∠BFD=60°（与 AE 的取值无关）',
    figure: (o) => buildFigure(F.G5_FIG, o),
  },
  {
    id: 'G6',
    topic: '锐角三角函数',
    level: '基础',
    image: 'G6.png',
    statement:
      'Rt△ABC 中，∠A=90°，AB=3，tanC=3/4。\n' +
      '(1) 求 AC 与 BC 的长；\n' +
      '(2) 求 sinC 与 cosC 的值。',
    known: { '∠A': '90°', AB: 3, tanC: '3/4' },
    answer: 'AC=4，BC=5；sinC=3/5，cosC=4/5',
    figure: (o) => buildFigure(F.G6_FIG, o),
  },
  {
    id: 'G7',
    topic: '正方形 / 三角函数',
    level: '中等',
    image: 'G7.png',
    statement:
      '正方形 ABCD 的边长为 4，点 E 是边 BC 的中点，连接 AE、DE。\n' +
      '(1) 求 AE 与 DE 的长；\n' +
      '(2) 求 tan∠AED 的值。',
    known: { 边长: 4 },
    answer: 'AE=DE=2√5；cos∠AED=3/5 ⇒ tan∠AED=4/3',
    figure: (o) => buildFigure(F.G7_FIG, o),
  },
  {
    id: 'G8',
    topic: '八字模型 / 角的关系',
    level: '基础',
    image: 'G8.png',
    statement:
      '线段 AB 与 CD 相交于点 O，连接 AD、CB。\n' +
      '(1) 说明∠A+∠D = ∠B+∠C；\n' +
      '(2) 若∠A=50°，∠D=70°，∠B=45°，求∠C 的度数。',
    answer: '两边都等于 180°−∠AOD；∠C=75°',
    figure: (o) => buildFigure(F.G8_FIG, o),
  },
  {
    id: 'G9',
    topic: '平行线分线段成比例',
    level: '基础',
    image: 'G9.png',
    statement:
      '△ABC 中，DE∥BC，点 D 在 AB 上，点 E 在 AC 上。已知 AD=4，DB=2，DE=6。\n' +
      '(1) 求 AD∶AB 的值；\n' +
      '(2) 求 BC 的长。',
    known: { AD: 4, DB: 2, DE: 6 },
    answer: 'AD∶AB=2∶3；△ADE∽△ABC ⇒ BC=DE×3/2=9',
    figure: (o) => buildFigure(F.G9_FIG, o),
  },
  {
    id: 'G10',
    topic: '圆 / 垂径定理',
    level: '基础',
    image: 'G10.png',
    statement:
      '⊙O 的半径为 5，弦 AB=8，过圆心 O 作 OH⊥AB 于点 H。\n' +
      '(1) 求 AH 的长；\n' +
      '(2) 求弦心距 OH 的长。',
    known: { 半径: 5, AB: 8 },
    answer: '垂径定理 ⇒ AH=4；OH=√(25−16)=3',
    figure: (o) => buildFigure(F.G10_FIG, o),
  },
  {
    id: 'G11',
    topic: '二次函数 / 图象与性质',
    level: '中等',
    image: 'G11.png',
    statement:
      '已知二次函数 y = x² − 2x − 3。\n' +
      '(1) 求它与 x 轴、y 轴的交点坐标；\n' +
      '(2) 求它的顶点坐标；\n' +
      '(3) 当 x 取何值时 y 随 x 的增大而减小？',
    known: { 解析式: 'y=x²−2x−3' },
    answer: '与 x 轴交于 (−1,0)、(3,0)，与 y 轴交于 (0,−3)；顶点 (1,−4)；x<1 时递减',
    figure: (o) => buildFigure(F.G11_FIG, o),
  },
  {
    id: 'G12',
    topic: '一次函数 / 面积',
    level: '基础',
    image: 'G12.png',
    statement:
      '直线 y = −2x + 6 与 x 轴交于点 P，与 y 轴交于点 Q。\n' +
      '(1) 求 P、Q 两点的坐标；\n' +
      '(2) 求△OPQ 的面积。',
    known: { 解析式: 'y=−2x+6' },
    answer: 'P(3,0)，Q(0,6)；面积 = 3×6/2 = 9',
    figure: (o) => buildFigure(F.G12_FIG, o),
  },

  /* ---- 以下 8 道：图形无法由题给条件唯一确定，只留题干 ---- */

  {
    id: 'G13',
    topic: '动点问题 / 函数关系',
    level: '较难',
    image: 'G13.png',
    statement:
      '矩形 ABCD 中，AB=6，BC=4。点 P 从点 B 出发沿 BC 以每秒 1 个单位的速度向 C 运动，' +
      '同时点 Q 从点 C 出发沿 CD 以每秒 2 个单位的速度向 D 运动。设运动时间为 t 秒（0<t≤2）。\n' +
      '(1) 用含 t 的式子表示 PC 与 CQ 的长；\n' +
      '(2) 求△PCQ 的面积 S 关于 t 的函数关系式；\n' +
      '(3) 当 S 取最大值时，求 t 的值。',
    known: { AB: 6, BC: 4 },
    answer: 'PC=4−t，CQ=2t；S=t(4−t)=−t²+4t；0<t≤2 上递增，t=2 时 S 最大为 4',
    figureNote: 'P、Q 的位置随 t 变化，画出来等于替读者选定一个 t，量出来的长度没有意义。',
  },
  {
    id: 'G14',
    topic: '相似三角形 / 分类讨论',
    level: '较难',
    image: 'G14.png',
    statement:
      '△ABC 中，∠B=90°，AB=6，BC=8。点 P 在边 AB 上，过 P 作 PQ 交边 AC 于点 Q，' +
      '使△APQ 与△ABC 相似。\n' +
      '(1) 求 AC 的长；\n' +
      '(2) 若 AP=2，求 AQ 的所有可能值。',
    known: { '∠B': '90°', AB: 6, BC: 8 },
    answer: 'AC=10；对应关系有两种：AQ=2×10/6=10/3 或 AQ=2×6/10=6/5',
    figureNote: '第 (2) 问的两种对应关系对应两个不同的 Q，画其中任何一个都会暗示答案只有一个。',
  },
  {
    id: 'G15',
    topic: '圆 / 切线',
    level: '中等',
    image: 'G15.png',
    statement:
      '⊙O 的半径为 6，点 P 在⊙O 外，OP=10。过点 P 作⊙O 的切线，切点为 A。\n' +
      '(1) 求 PA 的长；\n' +
      '(2) 求∠OPA 的正弦值。',
    known: { 半径: 6, OP: 10 },
    answer: 'OA⊥PA ⇒ PA=√(100−36)=8；sin∠OPA=OA/OP=3/5',
    figureNote: '切点 A 在圆上的位置取决于 P 的方向，题目未给定，任选一个都是替读者做决定。',
  },
  {
    id: 'G16',
    topic: '概率 / 列表法',
    level: '基础',
    image: 'G16.png',
    statement:
      '袋中有 3 个红球和 2 个白球，除颜色外完全相同。从中随机摸出两个球。\n' +
      '(1) 求两球同色的概率；\n' +
      '(2) 求两球恰好一红一白的概率。',
    answer: 'C(5,2)=10 种；同色 C(3,2)+C(2,2)=4 种 ⇒ 2/5；一红一白 3×2=6 种 ⇒ 3/5',
    figureNote: '概率题没有几何图形。',
  },
  {
    id: 'G17',
    topic: '方程应用 / 增长率',
    level: '基础',
    image: 'G17.png',
    statement:
      '某商品原价 100 元，连续两次以相同的百分率降价后售价为 81 元。\n' +
      '(1) 设每次降价的百分率为 x，列出方程；\n' +
      '(2) 求 x 的值。',
    answer: '100(1−x)²=81 ⇒ (1−x)²=0.81 ⇒ 1−x=0.9 ⇒ x=10%',
    figureNote: '应用题没有几何图形。',
  },
  {
    id: 'G18',
    topic: '统计 / 中位数与方差',
    level: '基础',
    image: 'G18.png',
    statement:
      '一组数据为：5，8，8，9，10。\n' +
      '(1) 求这组数据的平均数与中位数；\n' +
      '(2) 求这组数据的方差。',
    answer: '平均数 8，中位数 8；方差 = ((−3)²+0+0+1²+2²)/5 = 14/5 = 2.8',
    figureNote: '统计题没有几何图形。',
  },
  {
    id: 'G19',
    topic: '旋转 / 不确定构型',
    level: '较难',
    image: 'G19.png',
    statement:
      '正方形 ABCD 的边长为 4。将△ABD 绕点 A 逆时针旋转 α（0°<α<90°）得到△AB′D′，' +
      '连接 BB′、DD′。\n' +
      '(1) 求证：△ABB′∽△ADD′；\n' +
      '(2) 当 BB′=DD′ 时，求 α 的度数。',
    known: { 边长: 4 },
    answer: 'AB=AD 且∠BAB′=∠DAD′=α ⇒ 两个等腰三角形顶角相等而相似；BB′=DD′ 恒成立（AB=AD），故 0°<α<90° 内任意 α 均可',
    figureNote: '旋转角 α 是自由变量，选定一个角就等于替读者回答了第 (2) 问。',
  },
  {
    id: 'G20',
    topic: '几何最值 / 将军饮马',
    level: '较难',
    image: 'G20.png',
    statement:
      '在直线 l 的同侧有两点 A、B，点 A 到 l 的距离为 2，点 B 到 l 的距离为 3，' +
      '且 A、B 在 l 上的投影相距 6。点 P 在直线 l 上移动。\n' +
      '(1) 求 PA+PB 的最小值；\n' +
      '(2) 说明取到最小值时点 P 的位置。',
    known: { A到l的距离: 2, B到l的距离: 3, 投影间距: 6 },
    answer: '作 A 关于 l 的对称点 A′，PA+PB≥A′B=√(6²+(2+3)²)=√61；P 为 A′B 与 l 的交点',
    figureNote: '题目只给了距离关系，A、B 在 l 两侧的具体坐标未定，画出来会把"作对称点"这一步提前暴露。',
  },
];
