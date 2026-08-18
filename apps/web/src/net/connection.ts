import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { ORIGIN_AI, Scene, createUndoManager } from '@canvai/canvas-core';
import type { ClientMessage, ServerMessage } from '@canvai/protocol';
import type { FrameTagValue } from '@canvai/protocol';
import { FrameTag, ServerMessageSchema, decodeFrame, encodeFrame } from '@canvai/protocol';

export interface Presence {
  user: { id: string; name: string; color: string; kind: 'user' | 'ai' };
  cursor?: { x: number; y: number };
  selection?: string[];
  status?: string;
}

export interface ConnectionOptions {
  roomId: string;
  user: { id: string; name: string; color: string };
  onControl: (msg: ServerMessage) => void;
  onStatusChange?: (status: 'connecting' | 'open' | 'closed') => void;
}

/**
 * 一条 WebSocket 同时承载 Yjs 同步、awareness 和控制消息（见 protocol/events.ts 的分帧）。
 *
 * 断线自动重连并重新握手；重连期间本地改动照常写进 Y.Doc，
 * 恢复后 CRDT 会把这段离线编辑合并回去，用户感觉不到中断。
 */
export class Connection {
  readonly doc = new Y.Doc();
  readonly scene = new Scene(this.doc);
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /**
   * 撤销栈。只收自己的（ORIGIN_LOCAL）和 AI 的（ORIGIN_AI）改动——
   * 别人的内容不能被我撤掉。AI 的改动靠 SyncAI 帧识别，见下面的 handleFrame。
   */
  readonly undoManager = createUndoManager(this.scene);

  private ws: WebSocket | null = null;
  private retry = 0;
  private closedByUser = false;
  private reconnectTimer: number | null = null;

  constructor(private readonly opts: ConnectionOptions) {
    this.awareness.setLocalStateField('user', { ...opts.user, kind: 'user' });

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this || origin === ORIGIN_AI) return; // 来自服务端的更新不用回传
      const enc = encoding.createEncoder();
      syncProtocol.writeUpdate(enc, update);
      this.sendFrame(FrameTag.Sync, encoding.toUint8Array(enc));
    });

    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this) return;
      const changed = [...added, ...updated, ...removed];
      const enc = encoding.createEncoder();
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.sendFrame(FrameTag.Awareness, encoding.toUint8Array(enc));
    });
  }

  connect(): void {
    this.closedByUser = false;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // 丢弃上一条连接，避免它的 onclose 触发一次多余的重连
    this.teardown();
    this.opts.onStatusChange?.('connecting');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({
      room: this.opts.roomId,
      uid: this.opts.user.id,
      name: this.opts.user.name,
      color: this.opts.user.color,
    });
    const ws = new WebSocket(`${proto}//${location.host}/ws?${q}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.opts.onStatusChange?.('open');
      // 主动发 step1，双向握手更稳
      const enc = encoding.createEncoder();
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.sendFrame(FrameTag.Sync, encoding.toUint8Array(enc));
      this.send({ t: 'join', roomId: this.opts.roomId, user: this.opts.user });
    };

    ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      this.handleFrame(new Uint8Array(ev.data));
    };

    ws.onclose = () => {
      // 只有"当前"这条连接断了才重连。旧连接的 onclose 到得晚，
      // 若不做这个判断，它会在新连接已经建好之后再拉起一条，造成双连接。
      if (this.ws !== ws) return;
      this.ws = null;
      this.opts.onStatusChange?.('closed');
      if (this.closedByUser) return;
      this.retry++;
      const delay = Math.min(500 * 2 ** this.retry, 10_000);
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => ws.close();
  }

  /** 摘掉旧 socket 的所有回调再关闭，让它彻底静默 */
  private teardown(): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardown();
    this.opts.onStatusChange?.('closed');
  }

  private handleFrame(data: Uint8Array): void {
    const { tag, payload } = decodeFrame(data);

    switch (tag) {
      case FrameTag.Sync: {
        const dec = decoding.createDecoder(payload);
        const enc = encoding.createEncoder();
        syncProtocol.readSyncMessage(dec, enc, this.doc, this);
        if (encoding.length(enc) > 0) this.sendFrame(FrameTag.Sync, encoding.toUint8Array(enc));
        break;
      }

      case FrameTag.SyncAI: {
        // 用 ORIGIN_AI 应用，撤销栈才收得进去——用户要能一键撤掉 AI 刚画的东西
        const dec = decoding.createDecoder(payload);
        const enc = encoding.createEncoder();
        syncProtocol.readSyncMessage(dec, enc, this.doc, ORIGIN_AI);
        if (encoding.length(enc) > 0) this.sendFrame(FrameTag.Sync, encoding.toUint8Array(enc));
        break;
      }

      case FrameTag.Awareness: {
        const dec = decoding.createDecoder(payload);
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
        break;
      }

      case FrameTag.Control: {
        try {
          const msg = ServerMessageSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
          this.opts.onControl(msg);
        } catch (e) {
          console.warn('[conn] 无法解析控制消息', e);
        }
        break;
      }

      default:
        break;
    }
  }

  send(msg: ClientMessage): void {
    this.sendFrame(FrameTag.Control, new TextEncoder().encode(JSON.stringify(msg)));
  }

  private sendFrame(tag: number, payload: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeFrame(tag as FrameTagValue, payload));
  }

  setCursor(x: number, y: number): void {
    this.awareness.setLocalStateField('cursor', { x: Math.round(x), y: Math.round(y) });
  }

  setSelection(ids: string[]): void {
    this.awareness.setLocalStateField('selection', ids);
  }

  /** 除自己以外的在场者 */
  others(): Presence[] {
    const out: Presence[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.doc.clientID) return;
      const p = state as unknown as Presence;
      if (p.user) out.push(p);
    });
    return out;
  }
}
