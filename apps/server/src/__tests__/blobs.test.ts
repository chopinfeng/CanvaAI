import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBlobStore, R2BlobStore } from '../blobs.ts';

/**
 * R2 那条路只在云上跑，本地永远走不到——所以它反而最需要测。
 * 出问题的表现是"画布空了"，而那时候已经晚了。
 */

describe('本地文件', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'canvai-blob-'));
  });

  it('存了能读回来，没有的返回 null 而不是抛', async () => {
    const s = new FileBlobStore(dir);
    await s.put('rooms/a.ydoc', new Uint8Array([1, 2, 3]));
    expect([...(await s.get('rooms/a.ydoc'))!]).toEqual([1, 2, 3]);
    expect(await s.get('rooms/nope.ydoc')).toBeNull();
  });

  it('写完不留临时文件——原子写的那半截不能留在磁盘上', async () => {
    const s = new FileBlobStore(dir);
    await s.put('rooms/a.ydoc', new Uint8Array([1]));
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(dir, 'rooms'))).toEqual(['a.ydoc']);
  });

  it('key 里的 .. 跑不出目录——房间名是 URL 参数，谁都能填', async () => {
    const s = new FileBlobStore(dir);
    // 早先 `.` 在字符白名单里，`..` 原样穿过去，真能写到 data/ 外面
    await s.put('../../escaped', new Uint8Array([9]));

    const { readdir } = await import('node:fs/promises');
    expect(await readdir(dir)).toEqual(['escaped']);
  });
});

describe('R2', () => {
  const opts = {
    accountId: 'acct',
    bucket: 'canvai',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 截下 aws4fetch 最终发出的请求，看看 URL/方法对不对 */
  function capture(reply: (url: string, init: RequestInit) => Response) {
    const seen: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const req = input as { url?: string; method?: string };
      const url = typeof input === 'string' ? input : (req.url ?? String(input));
      seen.push({ url, method: req.method ?? init?.method ?? 'GET' });
      return reply(url, init ?? {});
    });
    return seen;
  }

  it('打到 <account>.r2.cloudflarestorage.com/<bucket>/<key>', async () => {
    const seen = capture(() => new Response(new Uint8Array([7]), { status: 200 }));
    const s = new R2BlobStore(opts);
    await s.get('rooms/a.ydoc');

    expect(seen[0]!.url).toContain('acct.r2.cloudflarestorage.com');
    expect(seen[0]!.url).toContain('/canvai/rooms/a.ydoc');
  });

  it('404 返回 null——新房间没有快照是正常的，不该抛', async () => {
    capture(() => new Response('', { status: 404 }));
    const s = new R2BlobStore(opts);
    expect(await s.get('rooms/new.ydoc')).toBeNull();
  });

  it('其他错误要抛出去，不能当成"没有"', async () => {
    capture(() => new Response('boom', { status: 500 }));
    const s = new R2BlobStore(opts);
    // 500 当成 null 的话，上层会拿空文档把用户的画盖掉
    await expect(s.get('rooms/a.ydoc')).rejects.toThrow(/500/);
  });

  it('写用 PUT', async () => {
    const seen = capture(() => new Response('', { status: 200 }));
    const s = new R2BlobStore(opts);
    await s.put('learners/u1.json', new TextEncoder().encode('{}'));
    expect(seen[0]!.method).toBe('PUT');
  });

  it('写失败要抛——静默失败等于数据没了还没人知道', async () => {
    capture(() => new Response('denied', { status: 403 }));
    const s = new R2BlobStore(opts);
    await expect(s.put('learners/u1.json', new Uint8Array([1]))).rejects.toThrow(/403/);
  });

  it('列目录从 XML 里取 Key', async () => {
    capture(
      () =>
        new Response(
          `<?xml version="1.0"?><ListBucketResult>
             <Contents><Key>learners/u1.json</Key></Contents>
             <Contents><Key>learners/u2.json</Key></Contents>
           </ListBucketResult>`,
          { status: 200 },
        ),
    );
    const s = new R2BlobStore(opts);
    expect(await s.list('learners')).toEqual(['learners/u1.json', 'learners/u2.json']);
  });
});
