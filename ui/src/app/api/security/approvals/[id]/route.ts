import { pendingRead, pendingReview } from '@/lib/pending-approval-http';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { return pendingRead(request, (await context.params).id); }
export async function POST(request: Request, context: Context) { return pendingReview(request, (await context.params).id); }
