import { Container, getContainer } from '@cloudflare/containers';

/**
 * Cloudflare 这一侧的入口。
 *
 * 它只做一件事：**把同一个房间的所有连接送进同一个容器**。
 *
 * 为什么这条最重要——这个应用的权威副本是容器**内存里**那份 Yjs 文档。
 * 要是按 getRandom() 分流，同一个房间的两个人可能落在两个容器上，
 * 各自维护一份文档，各自都觉得自己是对的。表现是"我画的他看不见"，
 * 而两边的日志都完全正常。所以必须按房间做亲和性。
 */

interface Env {
  CANVAI: DurableObjectNamespace<CanvaiContainer>;
}

export class CanvaiContainer extends Container {
  /** 和 Dockerfile 里 PORT 对上 */
  defaultPort = 8080;

  /**
   * 半小时没人碰就休眠。
   *
   * 敢这么设的前提是快照存在 R2 上（见 apps/server/src/blobs.ts）——
   * 容器磁盘是临时的，停一次就抹掉。要是还写在本地盘上，
   * 这个值等于"每半小时清空一次所有人的画"。
   */
  sleepAfter = '30m';

  envVars = {
    PORT: '8080',
    BASE_PATH: '/apps',
    NODE_ENV: 'production',
  };
}

/** 房间名从 query 取；取不到就给个固定值，别让 undefined 变成一堆各自为政的实例 */
function roomOf(request: Request): string {
  const room = new URL(request.url).searchParams.get('room');
  return room && room.trim() ? room.trim() : 'default';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = getContainer(env.CANVAI, roomOf(request));

    /**
     * 必须 startAndWaitForPorts 而不是 start：
     * start 在进程起来时就返回，端口还没监听，这时候转发过去是 connection refused。
     */
    await container.startAndWaitForPorts();

    // WebSocket 升级必须走 fetch()，containerFetch() 不支持升级，
    // 而且失败是静默的——页面打得开，就是永远连不上
    return container.fetch(request);
  },
};
