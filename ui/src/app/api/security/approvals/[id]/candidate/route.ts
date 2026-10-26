import { pendingCandidate } from '@/lib/pending-approval-http';
export const runtime = 'nodejs';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return pendingCandidate(request, (await context.params).id); }
