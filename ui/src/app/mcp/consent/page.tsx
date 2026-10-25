import { auth } from "@/lib/auth";
import { getDevicesForSub } from "@/lib/bridge-refresh";
import { mcpConsentRequest } from "@/lib/mcp-consent";
import { redirect } from "next/navigation";
import { McpSecureApproval, type McpConsentDetails } from "@/components/McpSecureApproval";

export const dynamic = "force-dynamic";
export default async function ConsentPage({ searchParams }: { searchParams: Promise<{ request?: string }> }) {
  const { request } = await searchParams;
  if (!request || !/^[A-Za-z0-9_-]{43}$/.test(request)) return <main className="p-8">Invalid authorization request.</main>;
  const session = await auth();
  if (!session?.user?.id || !session.user.email) redirect(`/login?returnTo=${encodeURIComponent(`/mcp/consent?request=${request}`)}`);
  try {
    const [details, owned] = await Promise.all([mcpConsentRequest<McpConsentDetails>(session.user.id, request, "inspect"), getDevicesForSub(session.user.email)]);
    const devices = owned.filter(device => !device.revoked && details.machines.includes(device.bridgeId));
    return <McpSecureApproval requestId={request} ownerId={session.user.id} email={session.user.email} details={details}
      devices={devices.map(device => ({ bridgeId: device.bridgeId, hostname: device.hostname }))} />;
  } catch {
    return <main className="p-8">This authorization request expired or is unavailable. Start again from your MCP client.</main>;
  }
}
