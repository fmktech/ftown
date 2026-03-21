import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

import type { Server, IncomingMessage, ServerResponse } from 'node:http';

export interface HookPayload {
  ftown_session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

export interface HookEvent {
  sessionId: string;
  eventName: string;
  data: Record<string, unknown>;
}

interface HookServerEvents {
  event: [HookEvent];
}

export class HookServer extends EventEmitter<HookServerEvents> {
  private server: Server | null = null;

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      server.on('error', (err: Error) => {
        console.error('[HookServer] Server error:', err.message);
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        this.server = server;
        console.log(`[HookServer] Listening on port ${address.port}`);
        resolve(address.port);
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const payload = JSON.parse(body) as Record<string, unknown>;

        const ftownSessionId = payload.ftown_session_id as string | undefined;
        const hookEventName = payload.hook_event_name as string | undefined;

        if (!ftownSessionId || !hookEventName) {
          res.writeHead(200);
          res.end('{"ok":true}');
          return;
        }

        console.log(`[HookServer] Received ${hookEventName} for ftown session ${ftownSessionId}`);

        const { ftown_session_id: _, ...rest } = payload;

        const hookEvent: HookEvent = {
          sessionId: ftownSessionId,
          eventName: hookEventName,
          data: rest as Record<string, unknown>,
        };

        this.emit('event', hookEvent);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (err) {
        console.error('[HookServer] Failed to parse hook payload:', err instanceof Error ? err.message : String(err));
        res.writeHead(400);
        res.end();
      }
    });

    req.on('error', (err: Error) => {
      console.error('[HookServer] Request error:', err.message);
      res.writeHead(500);
      res.end();
    });
  }
}
