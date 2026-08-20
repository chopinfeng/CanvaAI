/**
 * 部署前缀。
 *
 * 开发时页面挂在 `/`，线上要挂到 `https://xiaopingfeng.com/apps/` 下面。
 * 早先前端把 `/ws` `/kg` `/assets` 全写成了根路径——在子路径下这些请求
 * 会打到 `xiaopingfeng.com/ws`，也就是站点根，不是这个应用。
 *
 * Vite 在构建时把 `base` 注入成 `import.meta.env.BASE_URL`，永远以 `/` 结尾。
 * 所有对后端的调用都从这里取前缀，别再各写各的。
 */
const BASE = import.meta.env.BASE_URL || '/';

/** 拼一个后端接口地址：`api('kg/stats')` → `/apps/kg/stats` */
export function api(path: string): string {
  return BASE + path.replace(/^\//, '');
}

/**
 * WebSocket 地址。
 *
 * 跟着页面走 http/https —— 线上是 https，用 ws:// 会被浏览器直接拒掉
 * （mixed content），而且这个错在控制台里长得像"连不上服务器"，很难查。
 */
export function wsUrl(query: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${api('ws')}?${query}`;
}
