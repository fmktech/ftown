import { pendingInbox, pendingCreate } from '@/lib/pending-approval-http';
export const runtime = 'nodejs';
export const GET = pendingInbox;
export const POST = pendingCreate;
