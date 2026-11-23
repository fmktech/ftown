import { z } from 'zod';
import { boardColumnLabel } from './board-columns.js';

export const TICKET_NOTIFICATION_WIRE = '/api/tickets/notify';
export const TICKET_NOTIFICATION_INBOX = '/api/tickets/inbox';
export const ticketNotificationBody = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  projectName: z.string().min(1).max(256),
  ticketId: z.uuid(),
  title: z.string().min(1).max(512),
  stage: boardColumnLabel,
  reason: z.enum(['assignment', 'stage']),
  bridgeId: z.string().min(1).max(256),
  createdAt: z.iso.datetime(),
}).strict();
export type TicketNotice = z.infer<typeof ticketNotificationBody>;
