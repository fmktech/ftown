import { auth } from "@/lib/auth";
import { getDevicesForSub } from "@/lib/bridge-refresh";
import { mcpConsentRequest } from "@/lib/mcp-consent";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
interface Details {
  clientName: string;
  redirectUri: string;
  scopes: string[];
  machines: string[];
}
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; error?: string }>;
}) {
  const { request, error } = await searchParams;
  if (!request || !/^[A-Za-z0-9_-]{43}$/.test(request))
    return <main className="p-8">Invalid authorization request.</main>;
  const session = await auth();
  if (!session?.user?.id || !session.user.email)
    redirect(
      `/login?returnTo=${encodeURIComponent(`/mcp/consent?request=${request}`)}`,
    );
  let details: Details;
  let ownedDevices: Awaited<ReturnType<typeof getDevicesForSub>>;
  try {
    [details, ownedDevices] = await Promise.all([
      mcpConsentRequest<Details>(session.user.id, request, "inspect"),
      getDevicesForSub(session.user.email),
    ]);
  } catch {
    return (
      <main className="p-8">
        This authorization request has expired or is unavailable. Start again
        from your MCP client.
      </main>
    );
  }
  const devices = ownedDevices.filter(
    (d) => !d.revoked && details.machines.includes(d.bridgeId),
  );
  async function decide(form: FormData) {
    "use server";
    const current = await auth();
    if (!current?.user?.id || !current.user.email || current.user.id !== session!.user!.id)
      throw new Error("Sign in again");
    const denied = form.get("decision") === "deny";
    const machines = form.getAll("machine").map(String);
    if (!denied && !machines.length) redirect(`/mcp/consent?request=${request}&error=select`);
    const owned = (await getDevicesForSub(current.user.email))
      .filter((d) => !d.revoked)
      .map((d) => d.bridgeId);
    if (
      !denied &&
      (!machines.length || machines.some((id) => !owned.includes(id)))
    )
      throw new Error("Select machines belonging to your account");
    const result = await mcpConsentRequest<{ redirect: string }>(
      current.user.id,
      request!,
      denied ? "deny" : "approve",
      machines,
    );
    // The gateway validates this exact registered client redirect; prevent unexpected response redirects.
    const destination = new URL(result.redirect);
    const registered = new URL(details.redirectUri);
    if (
      destination.origin !== registered.origin ||
      destination.pathname !== registered.pathname
    )
      throw new Error("Unexpected authorization redirect");
    redirect(destination.href);
  }
  return (
    <main className="mx-auto max-w-xl p-8 space-y-5">
      <h1 className="text-2xl font-bold">
        Connect {details.clientName} to ftown
      </h1>
      <p>Signed in as {session.user.email}.</p>
      <p>
        {details.scopes.includes("mcp:control")
          ? "This client can read conversations, launch and stop agents, send messages, and execute terminal commands on the machines you select."
          : "This client can read session details, conversations, messages, and usage on the machines you select."}
      </p>
      <p className="text-sm">Client callback: {details.redirectUri}</p>
      {error === "select" && <p role="alert">Select at least one computer to allow access.</p>}
      <form action={decide} className="space-y-4">
        <fieldset>
          <legend className="font-semibold mb-2">
            Allow access to these computers
          </legend>
          {devices.map((d) => (
            <label key={d.bridgeId} className="block py-2">
              <input type="checkbox" name="machine" value={d.bridgeId} />{" "}
              {d.hostname ?? d.bridgeId}
            </label>
          ))}
          {!devices.length && (
            <p>No authorized computers are available for this account.</p>
          )}
        </fieldset>
        <button
          name="decision"
          value="approve"
          disabled={!devices.length}
          className="btn-primary mr-4"
        >
          Allow access
        </button>
        <button name="decision" value="deny" className="btn-ghost">
          Cancel
        </button>
      </form>
    </main>
  );
}
