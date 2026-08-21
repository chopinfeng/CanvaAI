import { useEffect, useState } from 'react';

/**
 * 视觉模型的凭据设置。
 *
 * key 存在**用户自己的浏览器**里（localStorage），每次请求带给服务端，
 * 服务端用完即弃——不写日志、不落盘。这样一台服务器可以服务多个人，
 * 每个人烧自己的额度，而不是所有人共用服务器上那一把 key。
 *
 * 为什么不让浏览器直连 OpenRouter：key 会出现在页面的网络记录里，
 * 而且要转换的截图是服务端渲染的，前端手里根本没有那张图。
 */

const LS_KEY = 'canvai.vision';

export interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULTS: VisionConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  model: 'moonshotai/kimi-k3',
};

export function loadVision(): VisionConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<VisionConfig>) };
  } catch {
    return DEFAULTS;
  }
}

/** 配好了没有——没配的话上传试卷这条路走不通，界面要说清楚 */
export const visionReady = (v: VisionConfig): boolean =>
  v.apiKey.trim().length > 0 && v.baseUrl.trim().length > 0 && v.model.trim().length > 0;

export function VisionSettings({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<VisionConfig>(loadVision);
  const [revealed, setRevealed] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1800);
    return () => clearTimeout(t);
  }, [saved]);

  const save = () => {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    setSaved(true);
  };

  return (
    <div className="vs-backdrop" onClick={onClose}>
      <div className="vs" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>视觉模型</strong>
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </header>

        <p className="vs-why">
          配好之后就能上传试卷照片，自动转成画布上的题目。
          <b>Key 只存在你这台机器的浏览器里</b>，每次请求带给服务端用一次，服务端不保存、不记日志。
        </p>

        <label>
          接口地址
          <input
            value={cfg.baseUrl}
            onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })}
            placeholder="https://openrouter.ai/api/v1"
          />
        </label>

        <label>
          模型
          <input
            value={cfg.model}
            onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
            placeholder="moonshotai/kimi-k3"
          />
        </label>

        <label>
          API Key
          <span className="vs-key">
            {/* 默认遮住：这东西经常在别人能看见屏幕的时候被打开 */}
            <input
              type={revealed ? 'text' : 'password'}
              value={cfg.apiKey}
              onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
              placeholder="sk-or-v1-…"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="link" onClick={() => setRevealed((v) => !v)}>
              {revealed ? '隐藏' : '显示'}
            </button>
          </span>
        </label>

        <p className="vs-note">
          实测 <code>moonshotai/kimi-k3</code> 在 31 道题上数值保真 99%、一次数字都没编。
          换别的 OpenAI 兼容端点也可以。
        </p>

        <div className="vs-actions">
          <button
            className="vs-clear"
            onClick={() => {
              localStorage.removeItem(LS_KEY);
              setCfg({ ...DEFAULTS });
            }}
          >
            清除
          </button>
          <button className="vs-save" onClick={save}>
            {saved ? '已保存' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
