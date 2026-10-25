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
    <figure aria-label="FTown encryption surfaces" className="space-y-4">
      <div className="grid gap-3 md:grid-cols-[1fr_1.2fr_1fr]">
        <Endpoint title="Browser / PWA" trusted>Non-extractable private key in this browser’s IndexedDB. Bridge fingerprints are pinned after an explicit invitation approval.</Endpoint>
        <div className="flex min-w-0 flex-col justify-center gap-2 rounded-lg border border-[var(--border-muted)] p-4 text-center text-xs">
          <div className="font-semibold text-[var(--accent)]">Application encryption ↔</div>
          <div className="leading-relaxed text-[var(--text-muted)]">Local HTTP / WebSocket · WebRTC P2P · Centrifugo relay</div>
          <div className="rounded border border-dashed border-[var(--border-muted)] p-2 text-[11px] text-[var(--text-faint)]">Relay carries opaque content; routing metadata remains visible.</div>
        </div>
        <Endpoint title="Your bridge" trusted>Private key and approved-device policy stay in its local data directory. Decrypted sessions, terminal history, and mail are processed here.</Endpoint>
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr_1.2fr_1fr]">
        <Endpoint title="AI / MCP client">Standard HTTPS + OAuth to the hosted MCP gateway. The client and its AI provider can see the requests and results you give them.</Endpoint>
        <Endpoint title="Hosted MCP gateway" trusted>Trusted plaintext endpoint for tools and results. Its distinct grant key uses authenticated encryption at rest in PostgreSQL; the wrapping secret is stored separately by the service.</Endpoint>
        <div className="flex flex-col justify-center gap-2 rounded-lg border border-[var(--border-muted)] p-4 text-center text-xs"><span className="font-semibold text-[var(--accent)]">Application encryption ↔ Bridge</span><span className="leading-relaxed text-[var(--text-muted)]">Browser-approved grant, pinned bridge key, read or control permission. No model PIN.</span></div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Endpoint title="Account, directory & notifications">HTTPS protects account login, OAuth consent, and device metadata in transit. Public keys, IDs, hostname, online state, sizes and timing are not hidden. Push carries a generic FTown notice and opaque routing references.</Endpoint>
        <Endpoint title="Local agents & model providers">The bridge decrypts before dispatching to local agents and tools. Their files, terminal data, and external model-provider connections have their own storage and trust boundaries. Local hook ingestion is an explicit plaintext exception.</Endpoint>
      </div>
      <figcaption className="space-y-2 border-t border-[var(--border-subtle)] pt-4 text-xs leading-relaxed text-[var(--text-faint)]">
        <p>Application encryption: HPKE Auth with P-256, HKDF-SHA256 and AES-256-GCM. Explicit invitation approval establishes trust; a mutable public-key directory cannot authorize a device. Security → Activity shows gateway attempts and independent bridge evidence.</p>
        <p>Browser crypto requires HTTPS or trustworthy localhost, including Solo. Plain LAN HTTP cannot unlock encrypted controls. Minimal health/discovery and local hook ingestion remain outside application framing.</p>
        <p>Endpoint software and an unlocked browser remain trusted. This does not provide anonymity, hardware-backed key protection, forward secrecy, or a zero-knowledge hosted MCP service.</p>
      </figcaption>
    </figure>
  </section>;
}
