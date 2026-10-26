import type { ReactNode } from "react";

function Endpoint({ title, children, trusted = false }: { title: string; children: ReactNode; trusted?: boolean }) {
  return <div className={`min-w-0 rounded-lg border p-4 ${trusted ? "border-[var(--accent-dim)] bg-[var(--bg-elevated)]" : "border-[var(--border-muted)] bg-[var(--bg-base)]"}`}>
    <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
    <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">{children}</p>
  </div>;
}

export function EncryptionDiagram() {
  return <section aria-labelledby="encryption-heading" className="mt-12 w-full max-w-[960px] space-y-5 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-4 sm:mt-16 sm:p-6">
    <div><p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--accent)]">Encryption &amp; trust</p>
      <h2 id="encryption-heading" className="font-[family-name:var(--font-sans)] text-2xl font-semibold tracking-tight">Follow the data, know the endpoints.</h2>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[var(--text-secondary)]">Approved endpoints encrypt application content before it leaves the device. Every route uses the same authenticated framing; a failed direct connection selects another encrypted route.</p>
    </div>
    <div aria-labelledby="device-approval-heading" className="space-y-3 rounded-lg border border-[var(--border-muted)] p-4">
      <h3 id="device-approval-heading" className="text-sm font-semibold text-[var(--text-primary)]">Add a device without copying a private link.</h3>
      <ol className="grid gap-3 sm:grid-cols-3">
        <li className="min-w-0 space-y-2 text-xs leading-relaxed"><p className="font-semibold text-[var(--accent)]">1. Request</p><p className="text-[var(--text-muted)]">Sign in on a new browser, or start a new computer for your account. It waits for approval and cannot read your sessions yet.</p></li>
        <li className="min-w-0 space-y-2 text-xs leading-relaxed"><p className="font-semibold text-[var(--accent)]">2. Review</p><p className="text-[var(--text-muted)]">On an approved browser, open Security → Devices → Pending approvals. Review the device you recognize. Review alone grants no access.</p></li>
        <li className="min-w-0 space-y-2 text-xs leading-relaxed"><p className="font-semibold text-[var(--accent)]">3. Compare &amp; confirm</p><p className="text-[var(--text-muted)]">Check the code on both actual devices and confirm locally on each. The trusted browser approves; verified approval unlocks encrypted access.</p></li>
      </ol>
      <p className="text-xs leading-relaxed text-[var(--text-faint)]">One browser approval covers current and future account computers. Each computer is approved once. Reject anything unexpected; cancel mismatched codes. First-device setup and private-link approval remain explicit alternatives.</p>
    </div>
    <figure aria-label="FTown encryption surfaces" className="space-y-4">
      <div className="grid gap-3 md:grid-cols-[1fr_1.2fr_1fr]">
        <Endpoint title="Browser / PWA" trusted>Separate non-extractable encryption and signing keys in this installation’s IndexedDB. Only an approved browser signs account device membership.</Endpoint>
        <div className="flex min-w-0 flex-col justify-center gap-2 rounded-lg border border-[var(--border-muted)] p-4 text-center text-xs">
          <div className="font-semibold text-[var(--accent)]">Application encryption ↔</div>
          <div className="leading-relaxed text-[var(--text-muted)]">Local HTTP / WebSocket · WebRTC P2P · Centrifugo relay</div>
          <div className="rounded border border-dashed border-[var(--border-muted)] p-2 text-[11px] text-[var(--text-faint)]">Relay carries opaque content; routing metadata remains visible.</div>
        </div>
        <Endpoint title="Your bridge" trusted>Encryption key and pinned signed account history stay in its local data directory. It cannot sign account device approvals. Decrypted sessions, terminal history, and mail are processed here.</Endpoint>
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr_1.2fr_1fr]">
        <Endpoint title="AI / MCP client">Standard HTTPS + OAuth to the hosted MCP gateway. The client and its AI provider can see the requests and results you give them.</Endpoint>
        <Endpoint title="Hosted MCP gateway" trusted>Trusted plaintext endpoint for tools and results. Its distinct grant key uses authenticated encryption at rest in PostgreSQL; the wrapping secret is stored separately by the service.</Endpoint>
        <div className="flex flex-col justify-center gap-2 rounded-lg border border-[var(--border-muted)] p-4 text-center text-xs"><span className="font-semibold text-[var(--accent)]">Application encryption ↔ Bridge</span><span className="leading-relaxed text-[var(--text-muted)]">Browser-approved grant, pinned bridge key, read or control permission. No model PIN.</span></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Endpoint title="Account, directory & notifications">HTTPS carries signed public device/computer history. The service orders and delivers updates; a directory alone cannot approve keys. IDs, hostname, online state, sizes and timing remain visible. Push carries a generic notice.</Endpoint>
        <Endpoint title="Local agents & model providers">The bridge decrypts before dispatching to local agents and tools. Their files, terminal data, and external model-provider connections have their own storage and trust boundaries. Local hook ingestion is an explicit plaintext exception.</Endpoint>
      </div>
      <figcaption className="space-y-2 border-t border-[var(--border-subtle)] pt-4 text-xs leading-relaxed text-[var(--text-faint)]">
        <p>Application encryption: HPKE Auth with P-256, HKDF-SHA256 and AES-256-GCM. Account history uses separate ECDSA P-256 signatures and pinned continuity. Security → Activity shows gateway attempts and independent bridge evidence.</p>
        <p>Saved browser requests resume on reload. Requests expire after five minutes; lost temporary verification state requires an explicit fresh attempt, including after a bridge process restart. A lost approval reply can resume the exact committed operation. Local recovery restores one computer, not lost account signing keys.</p>
        <p>Automatic approval uses a new FTown code-comparison protocol, not an externally audited protocol. Checking both devices provides approximately 48-bit protection per attempt; ignoring a mismatch defeats that check. The explicit private-link fallback uses a separate 256-bit secret and is never selected silently.</p>
        <p>Connected computers refresh account trust every 30 seconds. Account access pauses after 24 hours without a valid refresh; this is not a guaranteed revocation deadline against a service withholding updates. Existing bridge approvals require explicit migration; Solo and local recovery remain independent.</p>
        <p>Browser crypto requires HTTPS or trustworthy localhost, including Solo. Plain LAN HTTP cannot unlock encrypted controls. Minimal health/discovery and local hook ingestion remain outside application framing.</p>
        <p>Endpoint software and an unlocked browser remain trusted. This does not provide anonymity, hardware-backed key protection, forward secrecy, or a zero-knowledge hosted MCP service.</p>
      </figcaption>
    </figure>
  </section>;
}
