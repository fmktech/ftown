import { Centrifuge } from 'centrifuge';
import WebSocket from 'ws';

import type { Subscription, PublicationContext } from 'centrifuge';
import { hostname } from 'node:os';

import type { Command, CommandResponse, Session, BridgePresenceInfo } from './types.js';

type TerminalInputHandler = (sessionId: string, data: string) => void;
type TerminalResizeHandler = (sessionId: string, cols: number, rows: number) => void;

type CommandHandler = (command: Command) => void;

export class CentrifugoClient {
  private readonly client: Centrifuge;
  private readonly subscriptions: Map<string, Subscription> = new Map();

  constructor(url: string, token: string) {
    this.client = new Centrifuge(url, {
      token,
      websocket: WebSocket,
    });

    this.client.on('connecting', (ctx) => {
      console.log(`[Centrifugo] Connecting: ${ctx.reason}`);
    });

    this.client.on('connected', (ctx) => {
      console.log(`[Centrifugo] Connected to ${ctx.transport}`);
    });

    this.client.on('disconnected', (ctx) => {
      console.log(`[Centrifugo] Disconnected: code=${ctx.code} reason=${ctx.reason}`);
    });

    this.client.on('error', (ctx) => {
      console.error(`[Centrifugo] Error:`, ctx.error);
    });
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
        session,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish session update to ${channel}:`, err);
      throw err;
    }
  }

  async publishTerminalData(userId: string, sessionId: string, data: string): Promise<void> {
    const channel = `terminal:${sessionId}#${userId}`;
    if (!this.subscriptions.has(channel)) {
      const sub = this.client.newSubscription(channel);
      sub.subscribe();
      this.subscriptions.set(channel, sub);
    }
    try {
      await this.client.publish(channel, { type: 'output', data });
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish terminal data to ${channel}:`, err);
    }
  }

  subscribeToTerminalInput(
    userId: string,
    sessionId: string,
    onInput: TerminalInputHandler,
    onResize: TerminalResizeHandler,
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
    });

    sub.subscribe();
    this.subscriptions.set(channel, sub);
  }

  subscribeToCommands(userId: string, handler: CommandHandler): void {
    const channel = `commands#${userId}`;

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

  joinBridgesChannel(userId: string, bridgeId: string): void {
    const channel = `bridges#${userId}`;

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
      await this.client.publish(channel, event);
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish hook event to ${channel}:`, err);
    }
  }

  async publishCommandResponse(userId: string, response: CommandResponse): Promise<void> {
    const channel = `commands#${userId}`;
    try {
      await this.client.publish(channel, {
        type: 'command_response',
        response,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[Centrifugo] Failed to publish command response to ${channel}:`, err);
      throw err;
    }
  }
}
