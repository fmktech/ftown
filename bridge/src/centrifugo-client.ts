import { Centrifuge } from 'centrifuge';
import WebSocket from 'ws';

import type { Subscription, PublicationContext } from 'centrifuge';
import { hostname } from 'node:os';

import type { Command, CommandResponse, Loop, Session, BridgePresenceInfo } from './types.js';
import { toWireSession } from './session-wire.js';
import {
  isSignalMessage,
  isWatchMessage,
  type DirectCommandMessage,
  type SignalMessage,
} from './direct-transport/contract.js';

type TerminalInputHandler = (sessionId: string, data: string) => void;
type TerminalResizeHandler = (sessionId: string, cols: number, rows: number) => void;
type TerminalInitHandler = (sessionId: string) => void;

type CommandHandler = (command: Command) => void;
type DirectCommandHandler = (msg: DirectCommandMessage) => void;

const MAX_PUBLISH_BYTES = 460_000;

function byteLen(str: string): number {
  return Buffer.byteLength(str, 'utf8');
}

function truncateData(data: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(data);
  if (byteLen(json) <= MAX_PUBLISH_BYTES) return data;

  if (typeof data.data === 'string') {
    const overhead = byteLen(JSON.stringify({ ...data, data: '' }));
    const maxDataBytes = MAX_PUBLISH_BYTES - overhead - 100;
    let truncated = data.data;
    while (byteLen(truncated) > maxDataBytes) {
      truncated = truncated.slice(0, Math.floor(truncated.length * (maxDataBytes / byteLen(truncated))));
    }
    return { ...data, data: truncated + '\n[truncated]' };
  }

  if (typeof data.data === 'object' && data.data !== null) {
    const innerJson = JSON.stringify(data.data);
    if (byteLen(innerJson) > MAX_PUBLISH_BYTES) {
      return { ...data, data: { _truncated: true, _preview: innerJson.slice(0, 2000) } };
    }
  }

  return data;
}

export class CentrifugoClient {
  private readonly client: Centrifuge;
  private readonly subscriptions: Map<string, Subscription> = new Map();
  private readonly onReconnect?: () => void | Promise<void>;
  private hasConnected = false;

  constructor(
    url: string,
    token: string,
    getToken: () => Promise<string>,
    opts?: { onReconnect?: () => void | Promise<void> },
  ) {
    this.onReconnect = opts?.onReconnect;
    this.client = new Centrifuge(url, {
      token,
      getToken,
      websocket: WebSocket,
    });

    this.client.on('connecting', (ctx) => {
      console.log(`[Centrifugo] Connecting: ${ctx.reason}`);
    });

    this.client.on('connected', (ctx) => {
      console.log(`[Centrifugo] Connected to ${ctx.transport}`);
      // First 'connected' is the initial connect (startup resurrection already
      // publishes the sessions). Every later 'connected' is a reconnect after a
      // transport drop — re-sync so the UI, which does not re-fetch on its own,
      // recovers instead of showing a stale/empty list.
      if (this.hasConnected) void this.runOnReconnect();
      this.hasConnected = true;
    });

    this.client.on('disconnected', (ctx) => {
      console.log(`[Centrifugo] Disconnected: code=${ctx.code} reason=${ctx.reason}`);
      if (ctx.code === 3) {
        console.log(`[Centrifugo] Reconnecting after message size limit disconnect...`);
        setTimeout(() => this.client.connect(), 1000);
      }
    });

    this.client.on('error', (ctx) => {
      console.error(`[Centrifugo] Error:`, ctx.error);
    });
  }

  private async runOnReconnect(): Promise<void> {
    if (!this.onReconnect) return;
    try {
      await this.onReconnect();
    } catch (err) {
      console.error('[Centrifugo] onReconnect handler failed:', err);
    }
  }

  connect(): void {
    this.client.connect();
  }

  disconnect(): void {
    for (const [channel, sub] of this.subscriptions) {
      sub.unsubscribe();
      this.subscriptions.delete(channel);
    }
    this.client.disconnect();
  }

  subscribeToSessions(userId: string): void {
    const channel = `sessions:updates#${userId}`;
    const sub = this.client.newSubscription(channel);
    sub.subscribe();
    this.subscriptions.set(channel, sub);
  }

  async publishSessionUpdate(userId: string, session: Session): Promise<void> {
    const channel = `sessions:updates#${userId}`;
    try {
      await this.client.publish(channel, {
        type: 'session_update',
        session: toWireSession(session),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish session update to ${channel}:`, err);
      throw err;
    }
  }

  subscribeToLoops(userId: string): void {
    const channel = `loops:updates#${userId}`;
    const sub = this.client.newSubscription(channel);
    sub.subscribe();
    this.subscriptions.set(channel, sub);
  }

  async publishLoopUpdate(userId: string, loop: Loop): Promise<void> {
    const channel = `loops:updates#${userId}`;
    // Loop carries no secret env-like field, so — unlike sessions — nothing is stripped.
    try {
      await this.client.publish(channel, { type: 'loop_update', loop, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish loop update to ${channel}:`, err);
      throw err;
    }
  }

  async publishLoopRemoved(userId: string, loopId: string): Promise<void> {
    const channel = `loops:updates#${userId}`;
    try {
      await this.client.publish(channel, { type: 'loop_removed', loopId, timestamp: new Date().toISOString() });
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish loop removed to ${channel}:`, err);
      throw err;
    }
  }

  async publishTerminalData(userId: string, sessionId: string, data: string): Promise<void> {
    const channel = `terminal:${sessionId}#${userId}`;
    if (!this.subscriptions.has(channel)) {
      const sub = this.client.newSubscription(channel);
      this.subscriptions.set(channel, sub);
      await new Promise<void>((resolve) => {
        sub.on('subscribed', () => resolve());
        sub.subscribe();
      });
    }
    try {
      await this.client.publish(channel, truncateData({ type: 'output', data }));
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish terminal data to ${channel}:`, err);
    }
  }

  subscribeToTerminalInput(
    userId: string,
    sessionId: string,
    onInput: TerminalInputHandler,
    onResize: TerminalResizeHandler,
    onInit?: TerminalInitHandler,
  ): void {
    const channel = `terminal-input:${sessionId}#${userId}`;
    if (this.subscriptions.has(channel)) {
      return;
    }

    const sub = this.client.newSubscription(channel);

    sub.on('publication', (ctx: PublicationContext) => {
      const msg = ctx.data as { type: string; data?: string; cols?: number; rows?: number };
      if (msg.type === 'input' && msg.data !== undefined) {
        onInput(sessionId, msg.data);
      }
      if (msg.type === 'resize' && msg.cols !== undefined && msg.rows !== undefined) {
        onResize(sessionId, msg.cols, msg.rows);
      }
      if (msg.type === 'init' && onInit) {
        onInit(sessionId);
      }
    });

    sub.subscribe();
    this.subscriptions.set(channel, sub);
  }

  subscribeToCommands(userId: string, handler: CommandHandler, onDirectCommand?: DirectCommandHandler): void {
    const channel = `commands:rpc#${userId}`;

    const existingSub = this.subscriptions.get(channel);
    if (existingSub) {
      existingSub.unsubscribe();
      this.subscriptions.delete(channel);
    }

    const sub = this.client.newSubscription(channel);

    sub.on('publication', (ctx: PublicationContext) => {
      const data = ctx.data as Record<string, unknown>;
      if (data.type === 'command_response') {
        return;
      }
      if (onDirectCommand && (isSignalMessage(data) || isWatchMessage(data))) {
        try {
          onDirectCommand(data as unknown as DirectCommandMessage);
        } catch (err) {
          console.error(`[Centrifugo] Direct command handler failed on ${channel}:`, err);
        }
        return;
      }
      const command = data as unknown as Command;
      if (!command.type || !command.requestId) {
        return;
      }
      handler(command);
    });

    sub.on('subscribing', (ctx) => {
      console.log(`[Centrifugo] Subscribing to ${channel}: ${ctx.reason}`);
    });

    sub.on('subscribed', (ctx) => {
      console.log(`[Centrifugo] Subscribed to ${channel}, recoverable=${ctx.recoverable}`);
    });

    sub.on('error', (ctx) => {
      console.error(`[Centrifugo] Subscription error on ${channel}:`, ctx.error);
    });

    sub.on('unsubscribed', (ctx) => {
      console.log(`[Centrifugo] Unsubscribed from ${channel}: ${ctx.reason}`);
    });

    sub.subscribe();
    this.subscriptions.set(channel, sub);
  }

  // The loopback rung advert (localPort/localNonce) rides the connection JWT's
  // `info` claim, not subscription data — Centrifugo ignores subscribe data
  // without a subscribe proxy; presence exposes conn_info only.
  joinBridgesChannel(userId: string, bridgeId: string): void {
    const channel = `bridges:presence#${userId}`;

    const presenceInfo: BridgePresenceInfo = {
      bridgeId,
      hostname: hostname(),
      connectedAt: new Date().toISOString(),
    };

    const sub = this.client.newSubscription(channel, {
      data: presenceInfo,
    });

    sub.on('subscribed', () => {
      console.log(`[Centrifugo] Joined bridges channel as ${bridgeId} (${presenceInfo.hostname})`);
    });

    sub.on('error', (ctx) => {
      console.error(`[Centrifugo] Bridges channel error:`, ctx.error);
    });

    sub.subscribe();
    this.subscriptions.set(channel, sub);
  }

  async publishTerminalScreen(userId: string, sessionId: string, raw: string): Promise<void> {
    const channel = `terminal:${sessionId}#${userId}`;
    try {
      await this.client.publish(channel, {
        type: 'screen_dump',
        raw,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish terminal screen to ${channel}:`, err);
    }
  }

  async publishHookEvent(userId: string, sessionId: string, event: Record<string, unknown>): Promise<void> {
    const channel = `events:${sessionId}#${userId}`;
    if (!this.subscriptions.has(channel)) {
      const sub = this.client.newSubscription(channel);
      this.subscriptions.set(channel, sub);
      await new Promise<void>((resolve) => {
        sub.on('subscribed', () => resolve());
        sub.subscribe();
      });
    }
    try {
      await this.client.publish(channel, truncateData(event));
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish hook event to ${channel}:`, err);
    }
  }

  /** Publishes a bridge-originated WebRTC signaling message on the commands channel. */
  async publishSignal(userId: string, msg: SignalMessage): Promise<void> {
    const channel = `commands:rpc#${userId}`;
    try {
      await this.client.publish(channel, msg as unknown as Record<string, unknown>);
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish signal to ${channel}:`, err);
    }
  }

  async publishCommandResponse(userId: string, response: CommandResponse): Promise<void> {
    const channel = `commands:rpc#${userId}`;
    try {
      await this.client.publish(channel, truncateData({
        type: 'command_response',
        response: response as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      }));
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish command response to ${channel}:`, err);
      throw err;
    }
  }
}
