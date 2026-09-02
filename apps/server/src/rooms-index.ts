import * as Y from 'yjs';
import { Scene } from '@canvai/canvas-core';
import { blobs } from './blobs.ts';
import { currentGraph } from './knowledge.ts';
import { liveRoom } from './room.ts';
import { log } from './log.ts';

/**
 * 有哪些画布，每张是什么。
 *
 * 只给房间名是不够用的：`ugrad` `ugrad-scan` `amc` `drill-m2k9x` 摆在一起，
 * 没人记得哪个是哪张卷子。所以这里顺带把画布上第一段文字读出来当标题——
 * 它几乎总是题目的标题行，正是人用来认卷子的那句话。
 *
 * 代价是要把每个房间的文档解一遍。所以按文件修改时间缓存：房间没动过，
 * 就不再解第二遍。二十几个房间的目录列表，第二次之后基本是零成本。
 */

export interface RoomInfo {
  id: string;
  size: number;
  modified: number;
  shapes: number;
  /** 画布上第一段文字，用来认卷子；空画布就是 undefined */
  title?: string;
  /** 正开着的房间，磁盘快照可能是旧的，读的是内存里的实时状态 */
  live: boolean;
  /** 这份快照解不出来。仍然列出来，但要让人看见它坏了 */
  broken?: boolean;
  /**
   * 这张画布上的题考察哪些知识点。
   *
   * 掌握度是跟着人走的全局记录，但**一道题落在图谱的哪几个点上**
   * 是这道题自己的属性。放进列表里，是为了"我想练勾股定理"这种找法
   * ——按题目标题找是找不到的，标题往往只是"第 27 题"。
   */
  concepts?: Array<{ id: string; name: string }>;
}

/** key → { mtime, 解析结果 }。mtime 变了才重新解 */
const cache = new Map<
  string,
  { modified: number; shapes: number; title?: string; concepts?: Array<{ id: string; name: string }> }
>();

/** 挑一句能认出这张卷子的话 */
function titleOf(scene: Scene): string | undefined {
  const texts = scene.all().filter((s): s is typeof s & { text: string } => s.type === 'text' && Boolean((s as { text?: string }).text));
  if (texts.length === 0) return undefined;

  // 优先用标题角色的；没有就用最靠上的那段——版面上第一行本来就是标题位
  const titled = texts.find((s) => s.meta?.role === 'problem-title');
  const pick = titled ?? texts.reduce((a, b) => (a.y <= b.y ? a : b));
  return pick.text.split('\n')[0]!.slice(0, 60);
}

/** 画布上所有文字拼起来，用来认这道题考什么 */
function textOf(scene: Scene): string {
  return scene
    .all()
    .map((s) => (s.type === 'text' ? ((s as { text?: string }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

function conceptsOf(scene: Scene): Array<{ id: string; name: string }> {
  const g = currentGraph();
  if (!g) return [];
  return g.mentions(textOf(scene), { limit: 4 }).map((n) => ({ id: n.id, name: n.name }));
}

function parse(bytes: Uint8Array): { shapes: number; title?: string; concepts?: Array<{ id: string; name: string }> } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const scene = new Scene(doc);
  const title = titleOf(scene);
  const concepts = conceptsOf(scene);
  const out = {
    shapes: scene.size,
    ...(title ? { title } : {}),
    ...(concepts.length > 0 ? { concepts } : {}),
  };
  doc.destroy();
  return out;
}

export async function listRooms(): Promise<RoomInfo[]> {
  const items = (await blobs().listDetailed('rooms')).filter((b) => b.key.endsWith('.ydoc'));

  const out: RoomInfo[] = [];
  for (const b of items) {
    const id = decodeURIComponent(b.key.replace(/^rooms\//, '').replace(/\.ydoc$/, ''));

    /**
     * 正开着的房间直接读内存。
     *
     * 磁盘上是**上一次落盘**的快照——刚导入的试卷、刚画的批注可能都还没写下去。
     * 拿磁盘去描述一个正在用的房间，列表会显示一个几分钟前的旧样子，
     * 而用户刚在那张画布上干完活，一眼就知道列表在说谎。
     */
    const live = liveRoom(id);
    if (live) {
      const title = titleOf(live.scene);
      const concepts = conceptsOf(live.scene);
      out.push({
        id,
        size: b.size,
        modified: Date.now(),
        shapes: live.scene.size,
        ...(title ? { title } : {}),
        ...(concepts.length > 0 ? { concepts } : {}),
        live: true,
      });
      continue;
    }

    const hit = cache.get(b.key);
    if (hit && hit.modified === b.modified) {
      out.push({
        id,
        size: b.size,
        modified: b.modified,
        shapes: hit.shapes,
        ...(hit.title ? { title: hit.title } : {}),
        ...(hit.concepts ? { concepts: hit.concepts } : {}),
        live: false,
      });
      continue;
    }

    try {
      const bytes = await blobs().get(b.key);
      const info = bytes ? parse(bytes) : { shapes: 0 };
      cache.set(b.key, { modified: b.modified, ...info });
      out.push({ id, size: b.size, modified: b.modified, ...info, live: false });
    } catch (e) {
      /**
       * 一个坏文档不该让整张列表打不开。
       *
       * 磁盘上真的存在坏快照（room.snapshot_corrupt 就是为它加的），
       * 那种房间照样要在列表里出现——否则用户只会觉得自己的画布凭空消失了。
       */
      log.warn('rooms.parse_failed', { key: b.key, message: (e as Error).message });
      out.push({ id, size: b.size, modified: b.modified, shapes: 0, title: '（这份快照读不出来）', live: false, broken: true });
    }
  }

  /**
   * 空画布（2 字节的壳）不占位置，最近用的排前面。
   *
   * `|| r.broken` 不能省：坏快照的 shapes 也是 0，只按图元数过滤会把它一起滤掉——
   * 而那恰恰是最需要被看见的一种。用户的画布打不开，总好过用户的画布凭空消失。
   */
  return out.filter((r) => r.shapes > 0 || r.broken).sort((a, b) => b.modified - a.modified);
}
