import type { ToolCall } from './types.js';

/**
 * 把"漏成正文的工具调用"捞回来。
 *
 * DeepSeek 偶尔不走 tool_calls 字段，而是把调用当普通文本写进 content，
 * 用它内部的标记语法：
 *
 *   <｜｜DSML｜｜tool_calls>
 *   <｜｜DSML｜｜invoke name="interact_say">
 *   <｜｜DSML｜｜parameter name="text" string="true">看图上标红的这条…</｜｜DSML｜｜parameter>
 *   </｜｜DSML｜｜invoke>
 *   </｜｜DSML｜｜tool_calls>
 *
 * 不处理的话有两个后果：这次调用根本没执行（用户该听到的解释丢了），
 * 而且这坨标记会原样显示给用户。所以这里尽力解析回真正的调用，
 * 并把它从正文里剔掉；解析不出来就至少不让它露出去。
 *
 * 注意分隔符是全角竖线 U+FF5C，不是 ASCII 的 |。这里两种都容忍。
 */

const PIPE = '[|｜]';
const MARK = `<\\s*${PIPE}{1,2}\\s*DSML\\s*${PIPE}{1,2}\\s*`;

const BLOCK_RE = new RegExp(`${MARK}tool_calls\\s*>([\\s\\S]*?)<\\s*/\\s*${PIPE}{1,2}\\s*DSML\\s*${PIPE}{1,2}\\s*tool_calls\\s*>`, 'g');
const INVOKE_RE = new RegExp(`${MARK}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)<\\s*/\\s*${PIPE}{1,2}\\s*DSML\\s*${PIPE}{1,2}\\s*invoke\\s*>`, 'g');
const PARAM_RE = new RegExp(`${MARK}parameter\\s+name="([^"]+)"([^>]*)>([\\s\\S]*?)<\\s*/\\s*${PIPE}{1,2}\\s*DSML\\s*${PIPE}{1,2}\\s*parameter\\s*>`, 'g');

/** 正文里是否夹带了这类标记 */
export function hasLeakedCalls(text: string): boolean {
  return new RegExp(`${MARK}(tool_calls|invoke)`).test(text);
}

export interface ExtractResult {
  /** 剔除标记后的正文 */
  text: string;
  calls: ToolCall[];
  /** 检测到标记但一个都没解析出来 */
  unparsed: boolean;
}

export function extractLeakedCalls(text: string, idPrefix = 'leaked'): ExtractResult {
  if (!hasLeakedCalls(text)) return { text, calls: [], unparsed: false };

  const calls: ToolCall[] = [];
  let cleaned = text;
  let n = 0;

  cleaned = cleaned.replace(BLOCK_RE, (_whole, body: string) => {
    for (const inv of body.matchAll(INVOKE_RE)) {
      const name = inv[1]!;
      const args: Record<string, unknown> = {};

      for (const p of (inv[2] ?? '').matchAll(PARAM_RE)) {
        const key = p[1]!;
        const attrs = p[2] ?? '';
        const raw = (p[3] ?? '').trim();
        // string="true" 表示这个参数就是字符串，别再去 JSON 解析
        args[key] = /string\s*=\s*"true"/.test(attrs) ? raw : tryJson(raw);
      }

      calls.push({
        id: `${idPrefix}_${++n}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
    }
    return '';
  });

  // 没被 tool_calls 包住的裸 invoke 也捞一遍
  if (calls.length === 0) {
    cleaned = cleaned.replace(INVOKE_RE, (_whole, name: string, body: string) => {
      const args: Record<string, unknown> = {};
      for (const p of (body ?? '').matchAll(PARAM_RE)) {
        const attrs = p[2] ?? '';
        const raw = (p[3] ?? '').trim();
        args[p[1]!] = /string\s*=\s*"true"/.test(attrs) ? raw : tryJson(raw);
      }
      calls.push({
        id: `${idPrefix}_${++n}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
      return '';
    });
  }

  // 还剩下的残片（半截标记）一律抹掉，绝不让它显示给用户
  cleaned = cleaned.replace(new RegExp(`<\\s*/?\\s*${PIPE}{1,2}\\s*DSML\\s*${PIPE}{1,2}[^>]*>`, 'g'), '').trim();

  return { text: cleaned, calls, unparsed: calls.length === 0 };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
