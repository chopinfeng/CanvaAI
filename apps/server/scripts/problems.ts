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
  /**
   * 学段。加它是因为读题难度主要不由"题难不难"决定，而由**记号**决定：
   * 初中题基本是纯文本，高中开始有 ∫ ∑ 下标，本科有矩阵和希腊字母——
   * 后两者才是真正考验 OCR 的地方。基准按这个维度分组看才有意义。
   */
  stage?: '初中' | '高中' | '本科';
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

  /* ================================================================ *
   * 高中
   *
   * 从这里开始记号变了：出现导数撇号、下标、根号、离心率这类符号。
   * 读题难度主要不由"题难不难"决定，而由记号决定——这一段才开始
   * 真正考验 OCR。题目仍全部自编，用的是教科书里人人都在用的构型。
   * ================================================================ */

  {
    id: 'H1',
    stage: '高中',
    topic: '导数 / 切线方程',
    level: '基础',
    image: 'H1.png',
    statement:
      '已知函数 f(x) = x³ − 3x² + 2。\n' +
      '(1) 求 f′(x)；\n' +
      '(2) 求曲线 y = f(x) 在点 (1, f(1)) 处的切线方程。',
    known: { 'f(x)': 'x³−3x²+2', 切点横坐标: 1 },
    answer: "f′(x)=3x²−6x；f(1)=0，f′(1)=−3，切线 y=−3x+3",
    figureNote: '解析题，不依赖图形。',
  },

  {
    id: 'H2',
    stage: '高中',
    topic: '圆锥曲线 / 椭圆',
    level: '基础',
    image: 'H2.png',
    statement:
      '已知椭圆 C: x²/25 + y²/9 = 1。\n' +
      '(1) 求椭圆 C 的焦点坐标；\n' +
      '(2) 求椭圆 C 的离心率 e。',
    known: { 'a²': 25, 'b²': 9 },
    answer: 'c=4，焦点 (±4, 0)；e=4/5',
    figureNote: '标准椭圆，图形不画也不影响读题；此处考察的是记号识别。',
  },

  {
    id: 'H3',
    stage: '高中',
    topic: '数列 / 等差数列',
    level: '基础',
    image: 'H3.png',
    statement:
      '等差数列 {a_n} 中，a₁ = 3，公差 d = 4。\n' +
      '(1) 求 a₁₀；\n' +
      '(2) 求前 10 项和 S₁₀。',
    known: { a1: 3, d: 4, n: 10 },
    answer: 'a₁₀=39；S₁₀=210',
    figureNote: '数列题，无图。下标 aₙ / a₁₀ / S₁₀ 是这道题的识别难点。',
  },

  {
    id: 'H4',
    stage: '高中',
    topic: '三角恒等变换 / 二倍角',
    level: '中等',
    image: 'H4.png',
    statement:
      '已知 sin α = 3/5，且 α ∈ (0, π/2)。\n' +
      '(1) 求 cos α；\n' +
      '(2) 求 sin 2α 与 cos 2α 的值。',
    known: { 'sin α': '3/5', 'α 范围': '(0, π/2)' },
    answer: 'cos α=4/5；sin 2α=24/25，cos 2α=7/25',
    figureNote: '三角恒等式题，无图。希腊字母 α 和区间记号是识别难点。',
  },

  {
    id: 'H5',
    stage: '高中',
    topic: '立体几何 / 棱锥',
    level: '中等',
    image: 'H5.png',
    statement:
      '正四棱锥 P-ABCD 的底面是边长为 4 的正方形，高为 3。\n' +
      '(1) 求它的侧面积；\n' +
      '(2) 求它的体积。',
    known: { 底面边长: 4, 高: 3 },
    answer: '斜高 √13；侧面积 8√13；体积 16',
    figureNote: '立体图形用二维矢量表示会失真，宁可不画——画歪了 Agent 会拿它去测量。',
  },

  {
    id: 'H6',
    stage: '高中',
    topic: '概率 / 古典概型',
    level: '基础',
    image: 'H6.png',
    statement:
      '袋中有 3 个红球和 2 个白球，除颜色外完全相同。从中不放回地任取 2 个球。\n' +
      '(1) 求取出的 2 球恰好一红一白的概率；\n' +
      '(2) 求取出的 2 球同色的概率。',
    known: { 红球: 3, 白球: 2, 取球数: 2 },
    answer: '一红一白 3/5；同色 2/5',
    figureNote: '概率题，无图。',
  },

  /* ================================================================ *
   * 本科
   *
   * 记号密度再上一个台阶：积分号、矩阵、偏导符号、分布记号。
   * 这一段是整个基准里最能拉开差距的部分——一个视觉模型能不能把
   * ∫₀¹ 和 ∂f/∂x 读对，直接决定它能不能替掉人工转录。
   * ================================================================ */

  {
    id: 'U1',
    stage: '本科',
    topic: '微积分 / 分部积分',
    level: '中等',
    image: 'U1.png',
    statement: '计算定积分 ∫₀¹ x·eˣ dx。',
    known: { 被积函数: 'x·eˣ', 积分区间: '[0, 1]' },
    answer: '分部积分得 [x·eˣ − eˣ]₀¹ = (e − e) − (0 − 1) = 1',
    figureNote: '纯计算题，无图。积分号与上下限是识别难点。',
  },

  {
    id: 'U2',
    stage: '本科',
    topic: '线性代数 / 特征值',
    level: '中等',
    image: 'U2.png',
    statement:
      '已知矩阵 A = [[2, 1], [1, 2]]。\n' +
      '(1) 求 A 的全部特征值；\n' +
      '(2) 求各特征值对应的一个特征向量。',
    known: { A: '[[2,1],[1,2]]' },
    answer: '特征值 λ₁=1, λ₂=3；对应特征向量 (1,−1)ᵀ 与 (1,1)ᵀ',
    figureNote: '矩阵题，无图。方括号嵌套是识别难点——读错一个元素结论就全错。',
  },

  {
    id: 'U3',
    stage: '本科',
    topic: '概率论 / 泊松分布',
    level: '中等',
    image: 'U3.png',
    statement:
      '设随机变量 X 服从参数 λ = 2 的泊松分布，即 X ~ P(2)。\n' +
      '求 P(X ≤ 1)。',
    known: { 分布: 'P(λ=2)', λ: 2 },
    answer: 'P(X≤1)=P(0)+P(1)=e⁻²+2e⁻²=3e⁻²≈0.406',
    figureNote: '概率分布题，无图。分布记号 X ~ P(λ) 是识别难点。',
  },

  {
    id: 'U4',
    stage: '本科',
    topic: '常微分方程 / 二阶线性',
    level: '较难',
    image: 'U4.png',
    statement:
      '求解初值问题：\n' +
      'y″ − 3y′ + 2y = 0，y(0) = 3，y′(0) = 4。',
    known: { 方程: 'y″−3y′+2y=0', 'y(0)': 3, "y′(0)": 4 },
    answer: '特征根 r=1, 2；通解 y=C₁eˣ+C₂e²ˣ；代入初值得 C₁=2, C₂=1，故 y=2eˣ+e²ˣ',
    figureNote: '微分方程题，无图。撇号（y″ / y′）容易被读成引号。',
  },

  {
    id: 'U5',
    stage: '本科',
    topic: '多元微积分 / 偏导数',
    level: '中等',
    image: 'U5.png',
    statement:
      '设二元函数 f(x, y) = x²y + 3xy²。\n' +
      '求 ∂f/∂x 与 ∂f/∂y 在点 (1, 2) 处的值。',
    known: { 'f(x,y)': 'x²y+3xy²', 点: '(1, 2)' },
    answer: '∂f/∂x=2xy+3y²，在 (1,2) 处为 16；∂f/∂y=x²+6xy，在 (1,2) 处为 13',
    figureNote: '偏导计算题，无图。∂ 符号与下标是识别难点。',
  },
];
