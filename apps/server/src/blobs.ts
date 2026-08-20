import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { config } from './config.ts';
import { log } from './log.ts';

/**
 * 一层很薄的"存一块字节"抽象。
 *
 * 为什么需要它：本地跑的时候，房间快照和学习记录写在磁盘上就够了。
 * 但 Cloudflare Containers 的磁盘是**临时的**——容器一停（sleepAfter 到点、
 * 部署、崩溃）就抹掉重来。照原样搬上去，表现是"每次隔一阵回来，
 * 画布空了、学了几个月的掌握度也没了"，而且不报任何错。
 *
 * 所以把落盘这件事收到一个接口后面：本地用文件，云上用 R2。
 * 上面的 Room 和 LearnerStore 不需要知道自己写在哪儿。
 */
export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
  /** 给日志用，说清楚这次到底写到哪儿去了 */
  readonly kind: string;
}

/* ------------------------------------------------------------------ *
 * 本地文件
 * ------------------------------------------------------------------ */

export class FileBlobStore implements BlobStore {
  readonly kind = 'file';

  constructor(private readonly root: string) {}

  /**
   * key → 磁盘路径。
   *
   * 这里踩过一次：原来只把非 [\w.-] 的字符换成下划线，可 `.` 本来就在白名单里，
   * 于是 `..` 原样穿过去了，`../../x` 真的能写到 data/ 外面。
   * 房间名是 URL 参数，谁都能填——所以按段过滤掉 `.` 和 `..`，
   * 落地前再确认一次结果仍在 root 底下。
   */
  private path(key: string): string {
    const safe = key
      .split('/')
      .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
      .map((seg) => seg.replace(/[^\w.\-]/g, '_'))
      .join('/');

    const file = resolve(this.root, safe);
    const root = resolve(this.root);
    if (file !== root && !file.startsWith(root + sep)) {
      throw new Error(`非法 key：${key}`);
    }
    return file;
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  /**
   * 原子写：先写临时文件再 rename。
   *
   * 直接写的话，进程写到一半被杀会留下截断的文件，下次读失败 → 空文档 →
   * 再存一次就把用户的画彻底覆盖掉。rename 在同一文件系统内是原子的。
   */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const file = this.path(key);
    const tmp = `${file}.${process.pid}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.path(prefix);
    try {
      return (await readdir(dir)).map((f) => `${prefix.replace(/\/$/, '')}/${f}`);
    } catch {
      return [];
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/* ------------------------------------------------------------------ *
 * R2
 * ------------------------------------------------------------------ */

/**
 * R2 走 S3 兼容接口，不走 Worker binding。
 *
 * 容器里拿不到 `env.MY_BUCKET`——binding 只存在于 Worker 那一侧。
 * 容器是个独立的进程，要访问 R2 只能走 HTTPS + AK/SK 签名，
 * 和从任何一台机器访问 S3 是一回事。
 */
export class R2BlobStore implements BlobStore {
  readonly kind = 'r2';
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(opts: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: 'auto',
      /**
       * 默认重试 10 次且指数退避，一次 5xx 能把调用挂住好几分钟。
       * 存快照是在用户还在画的时候后台做的，宁可快点失败并报出来，
       * 也不要静静地卡住——那会让下一次 save 排在后面一起卡。
       */
      retries: 2,
    });
    this.base = `https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucket}`;
  }

  private url(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.client.fetch(this.url(key));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 读 ${key} 失败：${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * R2 的 PUT 本身就是原子的：要么整个对象换成新的，要么没换。
   * 所以这里不需要本地那套临时文件 + rename。
   */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const res = await this.client.fetch(this.url(key), {
      method: 'PUT',
      body: bytes,
      headers: { 'content-length': String(bytes.byteLength) },
    });
    if (!res.ok) throw new Error(`R2 写 ${key} 失败：${res.status} ${await res.text().catch(() => '')}`);
  }

  async list(prefix: string): Promise<string[]> {
    const u = new URL(this.base);
    u.searchParams.set('list-type', '2');
    u.searchParams.set('prefix', prefix.replace(/\/$/, '') + '/');
    const res = await this.client.fetch(u.toString());
    if (!res.ok) throw new Error(`R2 列 ${prefix} 失败：${res.status}`);
    const xml = await res.text();
    // 只需要 key，为这个引一个 XML 解析器不值当
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
  }

  async remove(key: string): Promise<void> {
    await this.client.fetch(this.url(key), { method: 'DELETE' });
  }
}

/* ------------------------------------------------------------------ *
 * 选一个
 * ------------------------------------------------------------------ */

let store: BlobStore | null = null;

/**
 * 配了 R2 就用 R2，否则用本地磁盘。
 *
 * 判断依据是"四个 R2 变量齐不齐"，缺一个就退回本地并在日志里说清楚——
 * 半配上的状态最危险：以为存在云上，其实写在一块随时会被抹掉的容器磁盘上。
 */
export function blobs(): BlobStore {
  if (store) return store;

  const { accountId, bucket, accessKeyId, secretAccessKey } = config.r2;
  const complete = accountId && bucket && accessKeyId && secretAccessKey;
  const partial = !complete && (accountId || bucket || accessKeyId || secretAccessKey);

  if (complete) {
    store = new R2BlobStore({ accountId, bucket, accessKeyId, secretAccessKey });
    log.info('blobs.r2', { bucket });
  } else {
    if (partial) {
      log.error('blobs.r2_incomplete', {
        note: 'R2 变量没配齐，退回本地磁盘。容器上的本地磁盘是临时的，数据会丢。',
        missing: Object.entries({ accountId, bucket, accessKeyId, secretAccessKey })
          .filter(([, v]) => !v)
          .map(([k]) => k),
      });
    }
    store = new FileBlobStore(config.dataDir);
    log.info('blobs.file', { dir: config.dataDir });
  }
  return store;
}

/** 测试用 */
export function setBlobs(s: BlobStore | null): void {
  store = s;
}
