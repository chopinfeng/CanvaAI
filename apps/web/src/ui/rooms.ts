import { api } from '../net/base';
import { loadVision, visionReady } from './VisionSettings';

/**
 * 画布（room）这件事的共用逻辑。
 *
 * 工具栏上的下拉切换器和整页的画布列表要做的事完全一样——列出来、跳过去、
 * 新建、把一张试卷传进一张新画布。两处各写一遍的话，
 * "传试卷"的两步交接（先传图拿 assetId 再跳转）迟早会有一处走样。
 */

export interface RoomInfo {
  id: string;
  size: number;
  modified: number;
  shapes: number;
  /** 画布上第一段文字，用来认卷子 */
  title?: string;
  /** 此刻有人开着 */
  live?: boolean;
  /** 这份快照解不出来 */
  broken?: boolean;
}

export async function fetchRooms(): Promise<RoomInfo[]> {
  const res = await fetch(api('rooms'));
  if (!res.ok) throw new Error(`列不出画布（${res.status}）`);
  return (await res.json() as { rooms: RoomInfo[] }).rooms;
}

/** 房间名会变成 URL 参数和磁盘文件名，先收拾干净 */
export function slug(raw: string): string {
  const s = raw
    .normalize('NFKD')
    .replace(/\.[a-z0-9]+$/i, '') // 去掉文件扩展名
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || `paper-${Math.random().toString(36).slice(2, 7)}`;
}

export function ago(ms: number): string {
  if (!ms) return '';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

/**
 * 跳到某张画布。
 *
 * 用整页跳转而不是原地换连接：房间名一变，Yjs 文档、WebSocket、awareness、
 * 撤销栈全都要换掉。原地换的话，任何一处没清干净都会表现成
 * "上一张画布的东西漏到这张来了"——而这种 bug 极难复现。
 * 一次跳转把这些全部归零，代价只是几十毫秒。
 */
export function goto(room: string, extra?: Record<string, string>): void {
  const q = new URLSearchParams();
  q.set('room', room);
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
  location.search = q.toString();
}

export const MAX_MB = 8;

/**
 * 传一张试卷，并且给它**单独开一张画布**。
 *
 * 顺序是：先把图传上去拿 assetId，再跳转，落地后由 ?import= 触发识别。
 * 之所以能这么做，是因为图已经落在服务端了——跳转不会把它弄丢。
 * 反过来（先跳转再传）就得把 File 对象带过页面边界，那是做不到的。
 *
 * 返回一句给人看的错误，没错就返回 null（跳转已经发生，函数不会往下走）。
 */
export async function uploadPaperToNewRoom(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/')) return '只能传图片。PDF 先截一页出来。';
  if (file.size > MAX_MB * 1024 * 1024) {
    return `图太大了（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_MB}MB。`;
  }
  try {
    const res = await fetch(api('assets'), {
      method: 'POST',
      headers: { 'content-type': file.type },
      body: await file.arrayBuffer(),
    });
    if (!res.ok) throw new Error(`上传失败 ${res.status}`);
    const { assetId } = (await res.json()) as { assetId: string };
    goto(slug(file.name), { import: assetId });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** 没配视觉 key 就走不通这条路，界面要先说清楚而不是等传完了才报错 */
export const needsVisionKey = (): boolean => !visionReady(loadVision());
