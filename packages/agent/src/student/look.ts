import { shapeBounds } from '@canvai/canvas-core';
import type { Scene } from '@canvai/canvas-core';
import type { Rect, Shape } from '@canvai/protocol';

/**
 * 把画布讲给学生听。
 *
 * 和给老师的 Context Header 不是一回事：老师要的是"下一步该查什么"，
 * 学生要的是"这道题写了什么、图上有哪些点和边、老师刚标了哪块"。
 * 所以这里文字优先——题干一个字都不能丢，几何图形按标签讲清楚。
 */
export function describeForStudent(scene: Scene, region?: Rect): string {
  const all = scene.all().filter((s) => (region ? overlaps(shapeBounds(s), region) : true));
  if (all.length === 0) return '画布上现在什么都没有。';

  const lines: string[] = [];

  /* ---- 文字：题干、已知量、老师写上去的标注 ---- */
  const texts = all.filter((s) => s.type === 'text' || s.type === 'latex').filter((s) => s.text?.trim());
  const byLayer = group(texts, (s) => s.layer);

  const problem = [...(byLayer.get('user') ?? [])].sort(topLeft);
  if (problem.length > 0) {
    lines.push('【卷子上的文字】');
    for (const s of problem) lines.push(indent(s.text!));
  }

  const notes = [...(byLayer.get('annot') ?? []), ...(byLayer.get('ai') ?? [])].sort(topLeft);
  if (notes.length > 0) {
    lines.push('【老师写在图上的】');
    for (const s of notes) lines.push(indent(s.text!));
  }

  /* ---- 图形：按标签讲，坐标只在需要动手画时才有用 ---- */
  const figures = all.filter((s) => s.type !== 'text' && s.type !== 'latex');
  if (figures.length > 0) {
    lines.push('【图形】');
    for (const s of figures.slice(0, 40)) {
      const b = shapeBounds(s);
      const who = s.layer === 'user' ? '题目里的' : s.author.kind === 'ai' ? '老师画的' : '你画的';
      const label = (s.meta.label as string | undefined) ?? (s.meta.role as string | undefined) ?? s.type;
      lines.push(`  ${s.id} ${who}${label}（${s.type}，在 ${b.map(Math.round).join(',')}）`);
    }
    if (figures.length > 40) lines.push(`  …还有 ${figures.length - 40} 个`);
  }

  return lines.join('\n');
}

const topLeft = (a: Shape, b: Shape): number => a.y - b.y || a.x - b.x;

const indent = (text: string): string =>
  text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');

function group<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

function overlaps(a: Rect, b: Rect): boolean {
  return !(a[0] + a[2] < b[0] || b[0] + b[2] < a[0] || a[1] + a[3] < b[1] || b[1] + b[3] < a[1]);
}
