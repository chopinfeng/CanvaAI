import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { WebSocket } from 'ws';
import { ORIGIN_AI, Scene } from '@canvai/canvas-core';
import type { AgentInputEvent, ClientMessage, ServerMessage } from '@canvai/protocol';
import type { FrameTagValue } from '@canvai/protocol';
import { ClientMessageSchema, FrameTag, decodeFrame, encodeFrame } from '@canvai/protocol';
import { AgentLoop, DeepSeekClient, ToolRegistry } from '@canvai/agent';
import type { SessionState } from '@canvai/agent';
import { assetStore } from './assets.ts';
import { config, hasAgent, hasVision } from './config.ts';
import { log } from './log.ts';
import { makeVisionProvider } from './vision.ts';
import { getRasterizer } from './rasterizer.ts';

const AGENT_CLIENT_ID = 0; // awareness 里 AI 占一个固定位

export interface RoomClient {
  id: string;
  socket: WebSocket;
  user: { id: string; name: string; color: string };
}

/**
 * 一个房间 = 一张画布 + 一个 Agent。
 *
 * 服务端持有 Yjs 权威副本：Agent 的工具直接改这份文档，
 * 改动通过 CRDT 广播到所有客户端。这样 Agent 完全不依赖浏览器在线，
 * 也让"给定场景 + 指令，断言产生的 op"这种无头测试成为可能。
 */
export class Room {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly scene: Scene;
  readonly awareness: awarenessProtocol.Awareness;
  readonly session: SessionState;

  private readonly clients = new Map<WebSocket, RoomClient>();
  private readonly agent: AgentLoop | null;
  private saveTimer: NodeJS.Timeout | null = null;
  private drainQueued = false;

  constructor(id: string) {
    this.id = id;
    this.doc = new Y.Doc();
    this.scene = new Scene(this.doc);
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.session = {
      selection: [],
      viewport: [0, 0, 1440, 900],
      zoom: 1,
      editMode: 'suggest',
      mode: 'assist',
      tutor: null,
    };

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.broadcastUpdate(update, origin);
      this.scheduleSave();
    });

    this.awareness.on('update', (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...changes.added, ...changes.updated, ...changes.removed];
      const enc = encoding.createEncoder();
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcastFrame(FrameTag.Awareness, encoding.toUint8Array(enc), origin instanceof Object ? origin : null);
    });

    this.agent = hasAgent() ? this.makeAgent() : null;
    if (!this.agent) {
      log.warn('room.agent_disabled', { room: this.id, hint: '未配置 DEEPSEEK_API_KEY；画布与协同仍然可用' });
    }
  }

  private makeAgent(): AgentLoop {
    const model = new DeepSeekClient({
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.baseUrl,
      model: config.deepseek.model,
      reasonerModel: config.deepseek.reasonerModel,
    });

    // 没配视觉模型就把 canvas_snapshot 摘掉——留着只会让模型反复去调一个读不出内容的工具
    const registry = new ToolRegistry(undefined, undefined, {
      exclude: hasVision() ? [] : ['canvas_snapshot'],
    });

    return new AgentLoop({
      model,
      registry,
      scene: this.scene,
      session: this.session,
      emit: (msg) => this.broadcastControl(msg),
      ...(hasVision() ? { vision: makeVisionProvider() } : {}),
      ...((): { rasterizer?: ReturnType<typeof getRasterizer> } => {
        const r = getRasterizer();
        return r ? { rasterizer: r } : {};
      })(),
      assets: assetStore,
      onUsage: (u) => {
        const hit = u.cachedTokens ?? 0;
        const rate = u.promptTokens > 0 ? Math.round((hit / u.promptTokens) * 100) : 0;
        log.info('agent.usage', { room: this.id, prompt: u.promptTokens, cacheHitPct: rate, completion: u.completionTokens });
      },
    });
  }

  /* ---------------------------------------------------------------- *
   * 连接
   * ---------------------------------------------------------------- */

  join(socket: WebSocket, user: RoomClient['user']): RoomClient {
    const client: RoomClient = { id: nanoid(8), socket, user };
    this.clients.set(socket, client);

    // Yjs 握手：先发 sync step1
    const enc = encoding.createEncoder();
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.send(socket, FrameTag.Sync, encoding.toUint8Array(enc));

    // 再把现有 awareness 状态推过去
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint8Array(
        aenc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      );
      this.send(socket, FrameTag.Awareness, encoding.toUint8Array(aenc));
    }

    this.sendControl(socket, {
      t: 'joined',
      roomId: this.id,
      selfId: client.id,
      agentId: String(AGENT_CLIENT_ID),
      editMode: this.session.editMode,
      mode: this.session.mode,
    });

    return client;
  }

  leave(socket: WebSocket): void {
    if (!this.clients.delete(socket)) return;
    // 只摘掉这个连接自己的 awareness 状态。
    // 早先这里把所有人的状态一起清了——一个人离开，全场光标都消失。
    const ids = this.awarenessBySocket.get(socket);
    if (ids && ids.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, ids, 'leave');
    }
    this.awarenessBySocket.delete(socket);
    void this.save();
  }

  /** 哪个连接带来了哪些 awareness clientID，断开时据此精确清理 */
  private readonly awarenessBySocket = new Map<WebSocket, number[]>();

  get clientCount(): number {
    return this.clients.size;
  }

  /* ---------------------------------------------------------------- *
   * 收帧
   * ---------------------------------------------------------------- */

  handleFrame(socket: WebSocket, data: Uint8Array): void {
    const { tag, payload } = decodeFrame(data);

    switch (tag) {
      case FrameTag.Sync: {
        const dec = decoding.createDecoder(payload);
        const enc = encoding.createEncoder();
        const type = syncProtocol.readSyncMessage(dec, enc, this.doc, socket);
        if (encoding.length(enc) > 0) this.send(socket, FrameTag.Sync, encoding.toUint8Array(enc));
        // 客户端发来 step2/update 时，doc 的 update 事件会负责广播
        void type;
        break;
      }

      case FrameTag.Awareness: {
        const dec = decoding.createDecoder(payload);
        const before = new Set(this.awareness.getStates().keys());
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), socket);
        // 记下这条连接引入的 clientID，断开时才知道该清谁
        const mine = this.awarenessBySocket.get(socket) ?? [];
        for (const id of this.awareness.getStates().keys()) {
          if (!before.has(id) && id !== AGENT_CLIENT_ID && !mine.includes(id)) mine.push(id);
        }
        this.awarenessBySocket.set(socket, mine);
        break;
      }

      case FrameTag.Control: {
        this.handleControl(socket, payload);
        break;
      }

      case FrameTag.Audio:
        // M4：转 ASR
        break;

      default:
        break;
    }
  }

  private handleControl(socket: WebSocket, payload: Uint8Array): void {
    let msg: ClientMessage;
    try {
      msg = ClientMessageSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
    } catch (e) {
      this.sendControl(socket, { t: 'error', message: '控制消息格式错误', detail: (e as Error).message });
      return;
    }

    switch (msg.t) {
      case 'ping':
        this.sendControl(socket, { t: 'pong' });
        break;

      case 'user.text':
        this.feedAgent({ kind: 'text', text: msg.text, at: Date.now() });
        break;

      case 'user.speech':
        if (msg.final) this.feedAgent({ kind: 'speech', text: msg.text, at: Date.now() });
        break;

      case 'user.draw':
        this.feedAgent({ kind: 'draw', shapeIds: msg.shapeIds, region: msg.region, at: Date.now() });
        break;

      case 'user.select':
        this.session.selection = msg.shapeIds;
        break;

      case 'user.viewport':
        this.session.viewport = msg.rect;
        this.session.zoom = msg.zoom;
        break;

      case 'suggest.resolve': {
        if (msg.accept) this.scene.promoteOp(msg.opId, 'ai', 'accept');
        else this.scene.deleteOp(msg.opId, 'reject');
        break;
      }

      case 'agent.abort':
        this.agent?.abort();
        break;

      case 'agent.answer':
        this.feedAgent({ kind: 'answer', askId: msg.askId, answer: msg.answer, at: Date.now() });
        break;

      case 'session.config':
        if (msg.editMode) this.session.editMode = msg.editMode;
        if (msg.mode && msg.mode !== this.session.mode) {
          this.session.mode = msg.mode;
          log.info('session.mode', { room: this.id, mode: msg.mode });
        }
        break;

      case 'join':
        // join 在连接建立时已处理
        break;
    }
  }

  /* ---------------------------------------------------------------- *
   * Agent
   * ---------------------------------------------------------------- */

  private feedAgent(event: AgentInputEvent): void {
    if (!this.agent) {
      this.broadcastControl({
        t: 'error',
        message: 'Agent 未启用',
        detail: '服务端没有配置 DEEPSEEK_API_KEY，请在 .env 里填上后重启。',
      });
      return;
    }

    this.agent.push(event);
    if (this.drainQueued) return;
    this.drainQueued = true;

    // 让出一个 tick，把紧邻的多个事件（比如「画完 + 说话」）合成一个回合
    queueMicrotask(async () => {
      await new Promise((r) => setTimeout(r, 50));
      this.drainQueued = false;
      try {
        await this.agent!.drain();
      } catch (e) {
        log.error('agent.turn_failed', { room: this.id, message: (e as Error).message, stack: (e as Error).stack });
        this.broadcastControl({ t: 'error', message: 'Agent 执行失败', detail: (e as Error).message });
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * 发送
   * ---------------------------------------------------------------- */

  private send(socket: WebSocket, tag: number, payload: Uint8Array): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(encodeFrame(tag as FrameTagValue, payload), { binary: true });
  }

  private sendControl(socket: WebSocket, msg: ServerMessage): void {
    this.send(socket, FrameTag.Control, new TextEncoder().encode(JSON.stringify(msg)));
  }

  broadcastControl(msg: ServerMessage): void {
    const payload = new TextEncoder().encode(JSON.stringify(msg));
    for (const { socket } of this.clients.values()) this.send(socket, FrameTag.Control, payload);
  }

  private broadcastUpdate(update: Uint8Array, origin: unknown): void {
    const enc = encoding.createEncoder();
    syncProtocol.writeUpdate(enc, update);
    // AI 的改动单独打标，客户端才能把它纳入撤销栈（见 FrameTag 的说明）
    const tag = origin === ORIGIN_AI ? FrameTag.SyncAI : FrameTag.Sync;
    this.broadcastFrame(tag, encoding.toUint8Array(enc), origin);
  }

  private broadcastFrame(tag: number, payload: Uint8Array, origin: unknown): void {
    for (const { socket } of this.clients.values()) {
      // 不回发给来源客户端，它已经有这份改动了
      if (origin === socket) continue;
      this.send(socket, tag, payload);
    }
  }

  /* ---------------------------------------------------------------- *
   * 持久化：500ms 防抖快照
   * ---------------------------------------------------------------- */

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 500);
  }

  private get file(): string {
    return join(config.dataDir, 'rooms', `${this.id}.ydoc`);
  }

  /**
   * 原子写：先写临时文件再 rename。
   *
   * 直接 writeFile 时，进程在写到一半被杀（重启、Ctrl-C、崩溃）会留下一个截断的文件，
   * 下次 load 解析失败 → 空文档 → 再存一次就把用户的画彻底覆盖掉。
   * rename 在同一文件系统内是原子的，快照要么是旧的完整版，要么是新的完整版。
   */
  async save(): Promise<void> {
    if (this.loadFailed) {
      // 上次没读懂磁盘上的快照，绝不能用内存里的空文档去盖掉它
      return;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(tmp, Y.encodeStateAsUpdate(this.doc));
      await rename(tmp, this.file);
    } catch (e) {
      log.error('room.save_failed', { room: this.id, file: this.file, message: (e as Error).message, stack: (e as Error).stack });
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** 快照存在但读不懂时置位——此后只读不写，等人来处理 */
  private loadFailed = false;

  async load(): Promise<void> {
    let buf: Buffer;
    try {
      buf = await readFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.loadFailed = true;
        log.error('room.read_failed', { room: this.id, file: this.file, message: (e as Error).message });
      }
      return; // 新房间没有快照，正常
    }

    try {
      Y.applyUpdate(this.doc, new Uint8Array(buf), 'load');
      log.info('room.loaded', { room: this.id, shapes: this.scene.size });
    } catch (e) {
      // 文件在但解析不了 —— 保留原件，不要静默丢弃用户的内容
      this.loadFailed = true;
      const backup = `${this.file}.corrupt.${Date.now()}`;
      await writeFile(backup, buf).catch(() => {});
      log.error('room.snapshot_corrupt', {
        room: this.id,
        backup,
        note: '本房间进入只读模式，不会覆盖磁盘上的文件',
        message: (e as Error).message,
      });
    }
  }

  async dispose(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.save();
    this.doc.destroy();
  }
}

/* ------------------------------------------------------------------ */

const rooms = new Map<string, Room>();

export async function getRoom(id: string): Promise<Room> {
  let room = rooms.get(id);
  if (!room) {
    room = new Room(id);
    await room.load();
    rooms.set(id, room);
  }
  return room;
}

export async function closeIdleRooms(): Promise<void> {
  for (const [id, room] of rooms) {
    if (room.clientCount === 0) {
      await room.dispose();
      rooms.delete(id);
    }
  }
}

/**
 * 退出前保存**所有**房间。
 *
 * 之前退出走的是 closeIdleRooms，它只处理没人连着的房间——
 * 恰恰把正在被使用、最有可能有未落盘改动的那些跳过了。
 */
export async function saveAllRooms(): Promise<void> {
  await Promise.all([...rooms.values()].map((r) => r.save()));
}
