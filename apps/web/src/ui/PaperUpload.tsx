import { useRef, useState } from 'react';
import type { Connection } from '../net/connection';
import { api } from '../net/base';
import { loadVision, visionReady } from './VisionSettings';

/**
 * 上传一张试卷照片，自动转成画布上的题目。
 *
 * 两步：先把图传到 /assets 拿到 assetId，再让服务端用视觉模型读它。
 * 图先落地是有原因的——转换可能失败（模型抽风、key 过期），
 * 那时候图还在，重试一次就行，不用让用户再拍一遍。
 */

const MAX_MB = 8;

export function PaperUpload({
  conn,
  onNeedKey,
}: {
  conn: Connection;
  onNeedKey: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pick = () => {
    // 没配 key 就先把设置面板推到他面前，而不是传完了再说"你没配 key"
    if (!visionReady(loadVision())) {
      onNeedKey();
      return;
    }
    fileRef.current?.click();
  };

  const upload = async (file: File) => {
    setErr(null);

    if (!file.type.startsWith('image/')) {
      setErr('只能传图片。PDF 的话先截一页出来。');
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setErr(`图太大了（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_MB}MB。`);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(api('assets'), {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) throw new Error(`上传失败 ${res.status}`);
      const { assetId } = (await res.json()) as { assetId: string };

      // key 从浏览器里取，跟着这一次请求走；服务端用完即弃
      const v = loadVision();
      conn.send({
        t: 'paper.import',
        assetId,
        vision: { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model },
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      // 清掉 value，否则连传同一张图两次不会触发 change
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <button className="tool" onClick={pick} disabled={busy} title="上传试卷照片，自动转成画布上的题目">
        {busy ? '上传中…' : '传试卷'}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      {err && <span className="upload-err">{err}</span>}
    </>
  );
}
