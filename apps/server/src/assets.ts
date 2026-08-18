import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { AssetStore } from '@canvai/agent';
import { config } from './config.ts';
import { log } from './log.ts';

/**
 * 图片资源存储。
 *
 * 按内容哈希命名：同一张图重复上传只占一份，且 id 天然稳定——
 * 重新注入一遍题目不会在磁盘上堆一堆副本。
 */

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([m, e]) => [e, m]),
);

/** 单张图上限，防止有人把整个 PDF 塞进来 */
export const MAX_ASSET_BYTES = 12 * 1024 * 1024;

const dir = () => join(config.dataDir, 'assets');

export function assetIdFor(bytes: Uint8Array, mime: string): string {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
  return `as_${hash}${MIME_EXT[mime] ?? '.bin'}`;
}

export const assetStore: AssetStore = {
  async put(bytes: Uint8Array, mime: string): Promise<string> {
    if (bytes.length > MAX_ASSET_BYTES) {
      throw new Error(`图片太大（${Math.round(bytes.length / 1e6)}MB），上限 ${MAX_ASSET_BYTES / 1e6}MB`);
    }
    const id = assetIdFor(bytes, mime);
    const path = join(dir(), id);

    // 已经存过就直接复用
    try {
      await stat(path);
      return id;
    } catch {
      /* 不存在，继续写 */
    }

    await mkdir(dir(), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    log.info('asset.put', { id, bytes: bytes.length, mime });
    return id;
  },

  /** 截图时把位图内嵌进 SVG。同步读没问题——canvas_snapshot 本来就低频。 */
  toDataUri(id: string): string | undefined {
    if (!/^as_[0-9a-f]{24}\.(png|jpg|webp|svg)$/.test(id)) return undefined;
    try {
      const bytes = readFileSync(join(dir(), id));
      const mime = EXT_MIME[extname(id)] ?? 'application/octet-stream';
      return `data:${mime};base64,${bytes.toString('base64')}`;
    } catch {
      return undefined;
    }
  },
};

export async function readAsset(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  // id 直接进文件路径，必须挡住 ../ 之类
  if (!/^as_[0-9a-f]{24}\.(png|jpg|webp|svg)$/.test(id)) return null;
  try {
    const bytes = await readFile(join(dir(), id));
    return { bytes, mime: EXT_MIME[extname(id)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

export function sniffMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
