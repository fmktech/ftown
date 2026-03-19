import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';

import type { Server, IncomingMessage, ServerResponse } from 'node:http';

export interface ClaudeHookPayload {
  session_id: string;
  ftown_session_id?: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
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
        const payload = JSON.parse(body) as ClaudeHookPayload;

        if (!payload.ftown_session_id) {
          res.writeHead(200);
          res.end('{"ok":true}');
          return;
        }

        console.log(`[HookServer] Received ${payload.hook_event_name} for ftown session ${payload.ftown_session_id}`);

        const hookEvent: HookEvent = {
          sessionId: payload.ftown_session_id,
          eventName: payload.hook_event_name,
          data: {
            cwd: payload.cwd,
            transcript_path: payload.transcript_path,
            ...(payload.tool_name ? { tool_name: payload.tool_name } : {}),
            ...(payload.tool_input ? { tool_input: payload.tool_input } : {}),
          },
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
