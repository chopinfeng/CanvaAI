import { describe, expect, it } from 'vitest';
import { Scene } from '@canvai/canvas-core';
import type { Rect, ServerMessage, ShapeInput } from '@canvai/protocol';
import { StudentAgent, type StudentPort } from '../student/student.js';
import { describeForStudent } from '../student/look.js';
import { ScriptedModel, call } from './harness.js';

/**
 * 学生 Agent 是用来测辅导的，所以它自己得先靠得住：
 * 该答的时候答、该看的时候看、不该自说自话的时候闭嘴。
 */

function makeStudent(steps: Array<{ text?: string; calls?: ReturnType<typeof call>[] }>, scene = new Scene()) {
  const acts: string[] = [];
  const port: StudentPort = {
    say: (t) => acts.push(`say:${t}`),
    answer: (id, t) => acts.push(`answer:${id}:${t}`),
    draw: (shapes: ShapeInput[]) => {
      const { ids } = scene.create(shapes, { author: { id: 'u1', kind: 'user' }, layer: 'user' });
      acts.push(`draw:${ids.length}`);
      return { ids, region: [0, 0, 10, 10] as Rect };
    },
    look: () => describeForStudent(scene),
  };
  const model = new ScriptedModel(steps);
  const student = new StudentAgent({ model, port, persona: '你是个学生。' });
  return { student, acts, model, scene };
}

const ask = (askId: string, question: string): ServerMessage => ({ t: 'agent.ask', askId, question });

describe('学生会答题', () => {
  it('老师问了，就把答案送回去', async () => {
    const { student, acts } = makeStudent([
      { calls: [call('student_answer', { text: '直角在 C' }), call('student_done', {})] },
    ]);

    student.observe(ask('ask_1', '直角在哪个顶点？'));
    const out = await student.act();

    expect(acts).toEqual(['answer:ask_1:直角在 C']);
    expect(out.answered).toEqual(['直角在 C']);
    expect(out.done).toBe(true);
    expect(student.waitingOnQuestion).toBe(false);
  });

  it('没人问的时候不自言自语', async () => {
    const { student, model } = makeStudent([{ calls: [call('student_say', { text: '在吗' })] }]);
    const out = await student.act();

    expect(out.steps).toBe(0);
    expect(model.callCount).toBe(0); // 一次模型调用都不该发生
  });

  it('答题之前能看见画布上的题目', async () => {
    const scene = new Scene();
    scene.create(
      [
        { type: 'text', x: 10, y: 10, text: '矩形 ABCD 中，AB=13，AD=5。', meta: { role: 'statement' } },
        { type: 'line', id: 'sh_af', points: [[0, 0], [100, 40]], meta: { label: 'AF' } },
      ],
      { author: { id: 'seed', kind: 'user' }, layer: 'user' },
    );

    const { student, acts } = makeStudent(
      [
        { calls: [call('student_look', {})] },
        { calls: [call('student_answer', { text: 'AB=13' }), call('student_done', {})] },
      ],
      scene,
    );

    student.observe(ask('ask_1', 'AB 多长？'));
    await student.act();

    // 模型第二步看到的 tool 结果里得真有题干
    const seen = JSON.stringify(acts);
    expect(seen).toContain('answer:ask_1:AB=13');
  });

  it('老师没在问却调了 answer，退化成主动说一句而不是丢掉', async () => {
    const { student, acts } = makeStudent([
      { calls: [call('student_say', { text: '给我讲这道题' })] },
      { calls: [call('student_answer', { text: '我算出来是 12' }), call('student_done', {})] },
    ]);

    await student.open('请求讲解');

    expect(acts).toContain('say:我算出来是 12');
  });

  it('看了一眼就想收工、一个字没说 → 推它一把，别让老师干等', async () => {
    const { student, acts } = makeStudent([
      // 实测它真会这样：看一眼画布，然后直接 done
      { calls: [call('student_look', {}), call('student_done', {})] },
      { calls: [call('student_answer', { text: 'DF=12' }), call('student_done', {})] },
    ]);

    student.observe(ask('ask_1', 'DF 是多少？'));
    const out = await student.act();

    expect(acts).toContain('answer:ask_1:DF=12');
    expect(out.answered).toEqual(['DF=12']);
  });

  it('推只推一次，不会两边空转', async () => {
    const { student, model } = makeStudent([
      { calls: [call('student_done', {})] },
      { calls: [call('student_done', {})] }, // 还是不说话
      { calls: [call('student_done', {})] },
    ]);

    student.observe(ask('ask_1', '看这里？'));
    await student.act();

    expect(model.callCount).toBe(2);
  });

  it('画得出东西，画完老师那边能收到', async () => {
    const { student, acts, scene } = makeStudent([
      {
        calls: [
          call('student_draw', {
            shapes: [{ type: 'line', points: [[0, 0], [50, 50]] }],
            note: '标了一条辅助线',
          }),
          call('student_done', {}),
        ],
      },
    ]);

    student.observe(ask('ask_1', '把 DF 标出来？'));
    const out = await student.act();

    expect(out.drew).toBe(1);
    expect(acts).toContain('draw:1');
    expect(scene.size).toBe(1);
  });
});

describe('学生看得懂老师在干什么', () => {
  it('判定、进度、模式变化都记下来了', async () => {
    const { student, model } = makeStudent([{ calls: [call('student_done', {})] }]);

    student.observe({ t: 'agent.judge', verdict: 'wrong', comment: '斜边认错了' });
    student.observe({ t: 'agent.todo', items: [{ text: '(1) 求 DF', done: true }, { text: '(2) 求 BE', done: false }] });
    student.observe({ t: 'session.mode', mode: 'tutor', auto: true, note: '（已切到辅导模式）' });
    await student.act();

    const prompt = JSON.stringify(model.seen[0]);
    expect(prompt).toContain('不对');
    expect(prompt).toContain('斜边认错了');
    expect(prompt).toContain('✓ (1) 求 DF');
    expect(prompt).toContain('▢ (2) 求 BE');
    expect(prompt).toContain('已切到辅导模式');
  });

  it('工具调用、光标这些不进它的视野——真实用户也不逐条读那些', async () => {
    const { student, model } = makeStudent([{ calls: [call('student_done', {})] }]);

    student.observe({ t: 'agent.pointer', to: { x: 1, y: 2 }, ms: 300 });
    student.observe({ t: 'agent.tool', turnId: 't1', call: { id: 'c1', name: 'canvas_query', args: {}, state: 'ok' } });
    student.observe(ask('ask_1', '看这里？'));
    await student.act();

    const prompt = JSON.stringify(model.seen[0]);
    expect(prompt).not.toContain('canvas_query');
    expect(prompt).toContain('看这里？');
  });
});

describe('把画布讲给学生听', () => {
  it('题干一个字不漏，图形按标签讲', () => {
    const scene = new Scene();
    scene.create(
      [
        { type: 'text', x: 0, y: 0, text: '(1) 求 DF 与 FC 的长；\n(2) 求线段 BE 的长。' },
        { type: 'line', id: 'sh_af', points: [[0, 0], [10, 10]], meta: { label: 'AF' } },
      ],
      { author: { id: 'seed', kind: 'user' }, layer: 'user' },
    );
    scene.create([{ type: 'text', x: 5, y: 5, text: 'AD = 5' }], {
      author: { id: 'agent', kind: 'ai' },
      layer: 'annot',
    });

    const text = describeForStudent(scene);
    expect(text).toContain('【卷子上的文字】');
    expect(text).toContain('(2) 求线段 BE 的长。');
    expect(text).toContain('【老师写在图上的】');
    expect(text).toContain('AD = 5');
    expect(text).toContain('题目里的AF');
  });

  it('画布空着就直说', () => {
    expect(describeForStudent(new Scene())).toContain('什么都没有');
  });
});
