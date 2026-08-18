import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * 从本文件所在位置向上找 .env，而不是依赖 process.cwd()。
 *
 * pnpm dev 会把工作目录设成 apps/server/，dotenv 默认只看 cwd，
 * 于是仓库根目录的 .env 被忽略——表现就是"明明填了 key 却说没配置"。
 * 就近的先加载：dotenv 不覆盖已存在的变量，所以 apps/server/.env 可以覆盖根目录的同名项。
 */
function loadEnvFiles(): string[] {
  const loaded: string[] = [];
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 6; depth++) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      dotenv.config({ path: file });
      loaded.push(file);
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // 兜底：从别处启动且 cwd 里有 .env 时也认
  const cwdEnv = resolve(process.cwd(), '.env');
  if (existsSync(cwdEnv) && !loaded.includes(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
    loaded.push(cwdEnv);
  }

  return loaded;
}

export const envFiles = loadEnvFiles();

/** 仓库根目录：以最外层那个 .env 所在位置为准，找不到就退回工作目录 */
const repoRoot = envFiles.length > 0 ? dirname(envFiles[envFiles.length - 1]!) : process.cwd();

const env = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;

/**
 * 路径类配置一律锚定仓库根。
 *
 * `.env` 里写 `DATA_DIR=./data` 是最自然的写法，但相对的是**进程工作目录**：
 * 从仓库根启动写到 <root>/data，从 apps/server 启动写到 apps/server/data，
 * 房间快照和图片资源就这么被劈成两份，而且完全没有任何报错。
 * 绝对路径照旧尊重，相对路径改为相对仓库根。
 */
const pathFromRoot = (key: string, fallback: string): string => {
  const raw = env(key, fallback);
  return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
};

export const config = {
  port: Number(env('PORT', '3001')),
  webOrigin: env('WEB_ORIGIN', 'http://localhost:5173'),
  dataDir: pathFromRoot('DATA_DIR', 'data'),
  logDir: pathFromRoot('LOG_DIR', 'logs'),
  logLevel: env('LOG_LEVEL', 'info'),

  deepseek: {
    apiKey: env('DEEPSEEK_API_KEY'),
    baseUrl: env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'),
    model: env('DEEPSEEK_MODEL', 'deepseek-chat'),
    reasonerModel: env('DEEPSEEK_REASONER_MODEL', 'deepseek-reasoner'),
  },

  vlm: {
    baseUrl: env('VLM_BASE_URL'),
    apiKey: env('VLM_API_KEY'),
    model: env('VLM_MODEL'),
    /** openai | anthropic；留空按 base URL 自动判断 */
    protocol: env('VLM_PROTOCOL'),
  },

  asr: { provider: env('ASR_PROVIDER', 'none'), baseUrl: env('ASR_BASE_URL'), apiKey: env('ASR_API_KEY') },
  tts: { provider: env('TTS_PROVIDER', 'none'), baseUrl: env('TTS_BASE_URL'), apiKey: env('TTS_API_KEY') },

  mathSidecarUrl: env('MATH_SIDECAR_URL', 'http://127.0.0.1:8787'),
} as const;

export const hasAgent = (): boolean => config.deepseek.apiKey.length > 0;
export const hasVision = (): boolean =>
  config.vlm.baseUrl.length > 0 && config.vlm.apiKey.length > 0 && config.vlm.model.length > 0;
