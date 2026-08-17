import type { ToolDef, ToolResult } from '@canvai/protocol';
import { TOOL_DEFS, err, toFunctionSchema } from '@canvai/protocol';
import type { FunctionSchema } from '../model/types.js';
import type { ToolContext, ToolExecutor } from './context.js';
import {
  execDescribe,
  execGetSelection,
  execGetViewport,
  execHitTest,
  execMeasure,
  execQuery,
  execSnapshot,
} from './canvas-read.js';
import {
  execAlign,
  execConnect,
  execCreate,
  execDelete,
  execDistribute,
  execErase,
  execGroup,
  execInk,
  execLayerClear,
  execLayerSetVisible,
  execStyle,
  execTransform,
  execUpdate,
} from './canvas-write.js';
import {
  execAskUser,
  execHighlight,
  execPointerMove,
  execSay,
  execSetStatus,
  execSetTodo,
  execSpotlight,
  execSuggest,
  execZoomTo,
} from './view-interact.js';

const EXECUTORS: Record<string, ToolExecutor> = {
  canvas_query: execQuery,
  canvas_describe: execDescribe,
  canvas_measure: execMeasure,
  canvas_hit_test: execHitTest,
  canvas_snapshot: execSnapshot,
  canvas_get_selection: execGetSelection,
  canvas_get_viewport: execGetViewport,

  canvas_create: execCreate,
  canvas_update: execUpdate,
  canvas_delete: execDelete,
  canvas_transform: execTransform,
  canvas_style: execStyle,
  canvas_group: execGroup,
  canvas_align: execAlign,
  canvas_distribute: execDistribute,
  canvas_connect: execConnect,
  canvas_ink: execInk,
  canvas_erase: execErase,
  canvas_layer_set_visible: execLayerSetVisible,
  canvas_layer_clear: execLayerClear,

  canvas_zoom_to: execZoomTo,
  canvas_spotlight: execSpotlight,
  canvas_highlight: execHighlight,
  canvas_pointer_move: execPointerMove,

  interact_say: execSay,
  interact_ask_user: execAskUser,
  interact_suggest: execSuggest,
  interact_set_status: execSetStatus,
  interact_set_todo: execSetTodo,
};

export class ToolRegistry {
  private readonly defs: Map<string, ToolDef>;
  private readonly execs: Map<string, ToolExecutor>;

  constructor(defs: readonly ToolDef[] = TOOL_DEFS, execs: Record<string, ToolExecutor> = EXECUTORS) {
    this.defs = new Map(defs.map((d) => [d.name, d]));
    this.execs = new Map(Object.entries(execs));

    // 定义与实现必须一一对应，缺一个就在启动时炸掉，而不是等模型调用时才发现
    for (const name of this.defs.keys()) {
      if (!this.execs.has(name)) throw new Error(`工具 ${name} 有定义但没有实现`);
    }
    for (const name of this.execs.keys()) {
      if (!this.defs.has(name)) throw new Error(`工具 ${name} 有实现但没有定义`);
    }
  }

  /** 送给模型的 function schema —— 属于稳定前缀，整个会话不变 */
  functionSchemas(): FunctionSchema[] {
    return [...this.defs.values()].map((d) => toFunctionSchema(d) as FunctionSchema);
  }

  isReadonly(name: string): boolean {
    return this.defs.get(name)?.readonly ?? false;
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  async execute(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
    const exec = this.execs.get(name);
    if (!exec) {
      return err(
        `没有名为 ${name} 的工具`,
        `可用工具：${[...this.defs.keys()].join(', ')}。请从中挑一个。`,
      );
    }

    let args: unknown;
    try {
      args = argsJson.trim() === '' ? {} : JSON.parse(argsJson);
    } catch {
      return err(
        `参数不是合法 JSON：${argsJson.slice(0, 200)}`,
        '请重新输出参数，确保是合法的 JSON 对象。数值不要带单位，字符串要用双引号。',
      );
    }

    try {
      return await exec(args, ctx);
    } catch (e) {
      if (isZodError(e)) {
        return err(
          `参数不符合 ${name} 的要求：${formatZodIssues(e)}`,
          '按错误里指出的字段修正参数后重试。必填字段不能省略，枚举值必须是列出的选项之一。',
        );
      }
      return err(
        `${name} 执行出错：${(e as Error).message}`,
        '换一种方式达成目标；如果连续失败，用 interact_ask_user 问用户，或用 interact_say 说明遇到的困难。',
      );
    }
  }
}

interface ZodLikeError {
  name: string;
  issues: Array<{ path: (string | number)[]; message: string }>;
}

function isZodError(e: unknown): e is ZodLikeError {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ZodError';
}

function formatZodIssues(e: ZodLikeError): string {
  return e.issues
    .slice(0, 6)
    .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
    .join('; ');
}

export { EXECUTORS };
