import { createHash } from 'node:crypto';
import { z } from 'zod';

export const boundedId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export const endpointSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  ownerId: z.string().min(1).max(200), kind: z.enum(['bridge', 'browser', 'mcp', 'local-cli']),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
}).strict().superRefine((endpoint, context) => {
  const raw = Buffer.from(endpoint.publicKey, 'base64url');
  if (raw.length !== 65 || raw[0] !== 4 || raw.toString('base64url') !== endpoint.publicKey
    || createHash('sha256').update(raw).digest('base64url') !== endpoint.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid endpoint fingerprint' });
  }
});
export const permissionSchema = z.enum(['read', 'control', 'admin']);
export const approvedSchema = z.object({
  endpoint: endpointSchema, label: z.string().max(100), permissions: z.array(permissionSchema).max(3),
  approvedAt: z.string().datetime(), grantId: boundedId.nullable(), expiresAt: z.string().datetime().nullable(),
}).strict();
export function displayLabel(label: string): string {
  return label.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 100);
}
