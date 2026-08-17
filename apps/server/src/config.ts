import 'dotenv/config';

const env = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;

export const config = {
  port: Number(env('PORT', '3001')),
  webOrigin: env('WEB_ORIGIN', 'http://localhost:5173'),
  dataDir: env('DATA_DIR', './data'),
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
  },

  asr: { provider: env('ASR_PROVIDER', 'none'), baseUrl: env('ASR_BASE_URL'), apiKey: env('ASR_API_KEY') },
  tts: { provider: env('TTS_PROVIDER', 'none'), baseUrl: env('TTS_BASE_URL'), apiKey: env('TTS_API_KEY') },

  mathSidecarUrl: env('MATH_SIDECAR_URL', 'http://127.0.0.1:8787'),
} as const;

export const hasAgent = (): boolean => config.deepseek.apiKey.length > 0;
export const hasVision = (): boolean =>
  config.vlm.baseUrl.length > 0 && config.vlm.apiKey.length > 0 && config.vlm.model.length > 0;
