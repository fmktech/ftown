import { z } from 'zod';
import type { Session } from '../../types.js';
import { BridgeSecurityError } from './errors.js';

const payloadSchema = z.object({ hook_event_name: z.literal('FtownNativeWake'), ftown_session_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  session_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), adapter: z.literal('claude-mod'), registerWake: z.boolean().optional() }).strict();

/** Deliberate trusted-local-provider IPC: no application route, message body, consumption or prompt execution. */
export async function nativeWake(input: unknown, dependencies: {
  getSession(id: string): Promise<Session | null>;
  register(session: Session, registration: { adapter: 'claude-mod'; nativeSessionId: string }): void;
  unread(id: string): Promise<{ id: string }[]>;
}): Promise<{ messages: { id: string }[] }> {
  const payload = payloadSchema.parse(input);
  const session = await dependencies.getSession(payload.ftown_session_id);
  if (!session || session.claudeSessionId !== payload.session_id) throw new BridgeSecurityError('wrong_context');
  if (payload.registerWake !== false) dependencies.register(session, { adapter: 'claude-mod', nativeSessionId: payload.session_id });
  return { messages: (await dependencies.unread(session.id)).slice(0, 500).map(message => ({ id: message.id })) };
}
