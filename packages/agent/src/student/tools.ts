import { z } from 'zod';
import { ShapeInputSchema, defineTool } from '@canvai/protocol';

/**
 * 学生能做的事。
 *
 * 刻意做得比老师那套窄：学生不需要 29 个工具，他只需要
 * 看一眼、答一句、偶尔在图上画点什么。工具越少，它越不容易跑偏去"扮演助手"。
 */

export const studentLook = defineTool({
  name: 'student_look',
  description:
    '看一眼画布：题目写了什么、图形长什么样、老师刚标出来的是哪块。' +
    '答题之前先看——老师说"图上标红的这个三角形"，你得真的去看是哪个。',
  input: z.object({
    /** 只想看某一块时给个区域，不给就看全部 */
    region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  }),
  readonly: true,
});

export const studentAnswer = defineTool({
  name: 'student_answer',
  description:
    '回答老师刚才的提问。这是你最常用的工具。' +
    '给具体答案（"直角在 C"、"DF=12"），不用把整个推理复述一遍。不会就直说不会。',
  input: z.object({ text: z.string() }),
});

export const studentSay = defineTool({
  name: 'student_say',
  description:
    '主动说话：提要求（"给我讲这道题"）、说卡住了、要求换个讲法、或者说不学了。' +
    '老师没在问你问题的时候用这个。',
  input: z.object({ text: z.string() }),
});

export const studentDraw = defineTool({
  name: 'student_draw',
  description:
    '在画布上画东西——辅助线、标记、写个式子。老师让你"标一下"、"画条线看看"时用。' +
    'points 里直接写画布绝对坐标，先 student_look 拿到图形的位置再画。',
  input: z.object({
    shapes: z.array(ShapeInputSchema).min(1),
    /** 一句话说明你画了什么，会连同图形一起告诉老师 */
    note: z.string().optional(),
  }),
});

export const studentDone = defineTool({
  name: 'student_done',
  description: '这一轮你说完了，把球交回给老师，等他回应。**每次动作的最后都要调它。**',
  input: z.object({}),
});

export const STUDENT_TOOLS = [studentLook, studentAnswer, studentSay, studentDraw, studentDone] as const;
