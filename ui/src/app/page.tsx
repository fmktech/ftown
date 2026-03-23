import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

function GitHubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

export default async function LandingPage() {
  const session = await auth();
  if (session?.user?.email) {
    redirect("/dashboard");
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-void)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Nav */}
      <nav
        style={{
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <span
          style={{
            fontSize: 14,
            fontWeight: 800,
            letterSpacing: "0.15em",
            color: "var(--accent)",
            textTransform: "uppercase",
            textShadow: "0 0 12px var(--accent-glow)",
          }}
        >
          ftown
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <a
            href="https://github.com/fmktech/ftown"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--text-muted)", display: "flex", alignItems: "center", transition: "color 0.15s" }}
          >
            <GitHubIcon />
          </a>
          <Link
            href="/login"
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              border: "1px solid var(--border-muted)",
              borderRadius: 4,
              padding: "6px 14px",
              textDecoration: "none",
              fontFamily: "var(--font-mono)",
              transition: "all 0.15s",
            }}
          >
            Sign In
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px" }}>
        <div style={{ maxWidth: 640, textAlign: "center" }}>
          <h1
            style={{
              fontSize: "clamp(28px, 5vw, 44px)",
              fontWeight: 800,
              color: "var(--text-primary)",
              lineHeight: 1.15,
              marginBottom: 16,
              letterSpacing: "-0.02em",
            }}
          >
            Orchestrate{" "}
            <span style={{ color: "var(--accent)", textShadow: "0 0 24px var(--accent-glow)" }}>
              Claude Code
            </span>
            {" "}from anywhere
          </h1>

          <p
            style={{
              fontSize: 14,
              color: "var(--text-secondary)",
              lineHeight: 1.7,
              maxWidth: 480,
              margin: "0 auto 32px",
            }}
          >
            Stream remote CLI sessions to your browser in real-time.
            Manage multiple machines, multiple sessions, all from a single dashboard.
            Self-hosted. Open source.
          </p>

          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link
              href="/register"
              className="btn-accent"
              style={{ fontSize: 13, padding: "10px 24px", textDecoration: "none", display: "inline-block" }}
            >
              Get Started
            </Link>
            <a
              href="https://github.com/fmktech/ftown"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
              style={{ fontSize: 13, padding: "10px 24px", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <GitHubIcon /> GitHub
            </a>
          </div>
        </div>

        {/* Architecture */}
        <div
          style={{
            marginTop: 56,
            padding: "24px 32px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-muted)",
            borderRadius: 8,
            maxWidth: 560,
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 0,
          }}
        >
          {/* Browser box */}
          <div style={{ textAlign: "center", flexShrink: 0 }}>
            <div style={{ border: "1px solid var(--border-muted)", borderRadius: 6, padding: "10px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>Browser</div>
              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Next.js</div>
            </div>
          </div>
          {/* Arrow + label */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0 8px", flexShrink: 1, minWidth: 0 }}>
            <span style={{ fontSize: 9, color: "var(--text-faint)", marginBottom: 4, whiteSpace: "nowrap" }}>WebSocket</span>
            <div style={{ width: "100%", minWidth: 40, height: 0, borderTop: "1px solid var(--border-muted)", position: "relative" }}>
              <span style={{ position: "absolute", left: -1, top: -4, color: "var(--text-faint)", fontSize: 8 }}>&lt;</span>
              <span style={{ position: "absolute", right: -1, top: -4, color: "var(--text-faint)", fontSize: 8 }}>&gt;</span>
            </div>
          </div>
          {/* Centrifugo box */}
          <div style={{ textAlign: "center", flexShrink: 0 }}>
            <div style={{ border: "1px solid var(--accent)", borderRadius: 6, padding: "10px 16px", boxShadow: "0 0 12px color-mix(in srgb, var(--accent) 15%, transparent)" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>Centrifugo</div>
              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>pub/sub</div>
            </div>
          </div>
          {/* Arrow + label */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0 8px", flexShrink: 1, minWidth: 0 }}>
            <span style={{ fontSize: 9, color: "var(--text-faint)", marginBottom: 4, whiteSpace: "nowrap" }}>WebSocket</span>
            <div style={{ width: "100%", minWidth: 40, height: 0, borderTop: "1px solid var(--border-muted)", position: "relative" }}>
              <span style={{ position: "absolute", left: -1, top: -4, color: "var(--text-faint)", fontSize: 8 }}>&lt;</span>
              <span style={{ position: "absolute", right: -1, top: -4, color: "var(--text-faint)", fontSize: 8 }}>&gt;</span>
            </div>
          </div>
          {/* Bridge box */}
          <div style={{ textAlign: "center", flexShrink: 0 }}>
            <div style={{ border: "1px solid var(--border-muted)", borderRadius: 6, padding: "10px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>Bridge</div>
              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>node-pty</div>
            </div>
          </div>
        </div>

        {/* Demo Videos */}
        <div style={{ marginTop: 48, width: "100%", maxWidth: 960 }}>
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>Desktop</div>
            <video
              autoPlay
              loop
              muted
              playsInline
              style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border-muted)" }}
            >
              <source src="/demo-desktop.mp4" type="video/mp4" />
            </video>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>Mobile</div>
            <video
              autoPlay
              loop
              muted
              playsInline
              style={{ width: "100%", maxWidth: 320, borderRadius: 8, border: "1px solid var(--border-muted)" }}
            >
              <source src="/demo-mobile.mp4" type="video/mp4" />
            </video>
          </div>
        </div>

        {/* Features */}
        <div
          style={{
            marginTop: 48,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 16,
            maxWidth: 640,
            width: "100%",
          }}
        >
          {[
            { icon: <TerminalIcon />, title: "Real-time streaming", desc: "Terminal output flows from remote machines to your browser via WebSocket" },
            { icon: <LayersIcon />, title: "Multi-session", desc: "Run and manage multiple Claude sessions across multiple machines simultaneously" },
            { icon: <GlobeIcon />, title: "Access anywhere", desc: "Mobile-optimized dashboard — manage sessions from your phone or tablet" },
            { icon: <ShieldIcon />, title: "Self-hosted", desc: "Deploy on your own infrastructure. Your code and conversations stay private." },
          ].map((f) => (
            <div
              key={f.title}
              style={{
                padding: "16px 20px",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
              }}
            >
              <div style={{ color: "var(--accent)", marginBottom: 8 }}>{f.icon}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>{f.title}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer
        style={{
          padding: "16px 24px",
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>MIT License</span>
        <span style={{ color: "var(--border-muted)" }}>/</span>
        <a
          href="https://github.com/fmktech/ftown"
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: "var(--text-faint)", textDecoration: "none" }}
        >
          github.com/fmktech/ftown
        </a>
      </footer>
    </div>
  );
}
