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

function AgentIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8V4H8" />
      <rect x="4" y="12" width="16" height="8" rx="2" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M12 12v0" />
      <path d="M9 16v.01" />
      <path d="M15 16v.01" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

function ZapIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

const SUPPORTED_AGENTS = [
  { name: "Claude Code", detail: "Anthropic + API providers" },
  { name: "Cursor Agent", detail: "agent CLI" },
  { name: "Codex", detail: "OpenAI Codex CLI" },
  { name: "opencode", detail: "interactive CLI" },
  { name: "Shell", detail: "zsh on bridge" },
] as const;

const STEPS = [
  {
    n: "1",
    title: "Run the bridge",
    desc: "Start ftown-bridge on any machine — laptop, server, or VM. It installs the CLI and registers itself with your dashboard.",
  },
  {
    n: "2",
    title: "Open your browser",
    desc: "Sign in to the ftown UI from desktop or phone. Every bridge and its agent sessions show up live — no SSH, no port forwarding.",
  },
  {
    n: "3",
    title: "Orchestrate the swarm",
    desc: "Spawn Claude Code, Cursor, Codex, opencode, or a shell. Run them in parallel, resume chats, and drive them all from anywhere.",
  },
] as const;

const STATS = [
  { value: "5", label: "agent CLIs supported" },
  { value: "∞", label: "parallel sessions" },
  { value: "100%", label: "self-hosted" },
  { value: "MIT", label: "open source" },
] as const;

const FEATURES = [
  {
    icon: <AgentIcon />,
    title: "Multi-agent orchestration",
    desc: "Run Claude Code, Cursor Agent, Codex, opencode, or a raw shell — each as a full interactive TUI streamed to your browser.",
  },
  {
    icon: <TerminalIcon />,
    title: "Real-time terminal streaming",
    desc: "PTY output flows over WebSocket with scrollback replay, resize sync, and mobile-friendly controls.",
  },
  {
    icon: <LayersIcon />,
    title: "Multi-bridge & multi-session",
    desc: "Connect many machines with ftown-bridge. Run parallel agent sessions and organize them from one dashboard.",
  },
  {
    icon: <RefreshIcon />,
    title: "Resume where you left off",
    desc: "Pick up prior Claude or Cursor Agent chats per workspace. Bridge exec lists sessions from the remote machine.",
  },
  {
    icon: <ZapIcon />,
    title: "Hook events in the UI",
    desc: "Bridge installs notify hooks into Claude and Cursor configs so tool use and activity show up live in the dashboard.",
  },
  {
    icon: <GlobeIcon />,
    title: "Access anywhere",
    desc: "Mobile-optimized layout, PWA install, and connection diagnostics — manage agents from phone or desktop.",
  },
  {
    icon: <ShieldIcon />,
    title: "Self-hosted & private",
    desc: "Your stack: Next.js UI, Centrifugo pub/sub, PostgreSQL auth, and bridges on your own hardware or cloud.",
  },
] as const;

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
        {/* Hero row: text left, mobile video right */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 48,
            width: "100%",
            maxWidth: 960,
            flexWrap: "wrap",
          }}
        >
          {/* Left: text + CTAs */}
          <div style={{ flex: "1 1 400px", minWidth: 0 }}>
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
              A swarm of{" "}
              <span style={{ color: "var(--accent)", textShadow: "0 0 24px var(--accent-glow)" }}>
                coding agents
              </span>
              , driven from any browser
            </h1>

            <p
              style={{
                fontSize: 14,
                color: "var(--text-secondary)",
                lineHeight: 1.7,
                maxWidth: 520,
                marginBottom: 20,
              }}
            >
              Stop SSHing in to babysit agents. ftown streams Claude Code, Cursor, Codex and
              more as live terminals to your browser — across every machine you own, from your
              phone or your desktop. Self-hosted, on the subscriptions you already pay for. No
              port forwarding, no screen sharing.
            </p>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                marginBottom: 28,
                maxWidth: 520,
              }}
            >
              {SUPPORTED_AGENTS.map((agent) => (
                <span
                  key={agent.name}
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    padding: "4px 10px",
                    borderRadius: 4,
                    border: "1px solid var(--border-muted)",
                    background: "var(--bg-surface)",
                    color: "var(--text-secondary)",
                  }}
                  title={agent.detail}
                >
                  {agent.name}
                </span>
              ))}
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  padding: "4px 10px",
                  borderRadius: 4,
                  border: "1px dashed var(--border-muted)",
                  color: "var(--text-faint)",
                }}
              >
                + z.ai · Kimi · DeepSeek · Fireworks via Claude
              </span>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link
                href="/register"
                className="btn-accent"
                style={{ fontSize: 13, padding: "10px 24px", textDecoration: "none", display: "inline-block" }}
              >
                Self-host (Open Source)
              </Link>
              <Link
                href="/register"
                className="btn-ghost"
                style={{ fontSize: 13, padding: "10px 24px", textDecoration: "none", display: "inline-block", border: "1px solid var(--accent)", color: "var(--accent)" }}
              >
                Try Hosted — Free for limited time
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

          {/* Right: mobile demo */}
          <div style={{ flexShrink: 0 }}>
            <video
              autoPlay
              loop
              muted
              playsInline
              style={{ width: 220, borderRadius: 12, border: "1px solid var(--border-muted)" }}
            >
              <source src="/demo-mobile.mp4" type="video/mp4" />
            </video>
          </div>
        </div>

        {/* Architecture diagram */}
        <div
          style={{
            marginTop: 48,
            padding: "24px 32px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-muted)",
            borderRadius: 8,
            maxWidth: 560,
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ textAlign: "center", flexShrink: 0 }}>
            <div style={{ border: "1px solid var(--border-muted)", borderRadius: 6, padding: "10px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>Browser</div>
              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Next.js</div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0 8px", flexShrink: 1, minWidth: 0 }}>
            <span style={{ fontSize: 9, color: "var(--text-faint)", marginBottom: 4, whiteSpace: "nowrap" }}>WebSocket</span>
            <div style={{ width: "100%", minWidth: 40, height: 0, borderTop: "1px solid var(--border-muted)", position: "relative" }}>
              <span style={{ position: "absolute", left: -1, top: -4, color: "var(--text-faint)", fontSize: 8 }}>&lt;</span>
              <span style={{ position: "absolute", right: -1, top: -4, color: "var(--text-faint)", fontSize: 8 }}>&gt;</span>
            </div>
          </div>
          <div style={{ textAlign: "center", flexShrink: 0 }}>
            <div style={{ border: "1px solid var(--accent)", borderRadius: 6, padding: "10px 16px", boxShadow: "0 0 12px color-mix(in srgb, var(--accent) 15%, transparent)" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>Centrifugo</div>
              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>pub/sub</div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0 8px", flexShrink: 1, minWidth: 0 }}>
            <span style={{ fontSize: 9, color: "var(--text-faint)", marginBottom: 4, whiteSpace: "nowrap" }}>WebSocket</span>
            <div style={{ width: "100%", minWidth: 40, height: 0, borderTop: "1px solid var(--border-muted)", position: "relative" }}>
              <span style={{ position: "absolute", left: -1, top: -4, color: "var(--text-faint)", fontSize: 8 }}>&lt;</span>
              <span style={{ position: "absolute", right: -1, top: -4, color: "var(--text-faint)", fontSize: 8 }}>&gt;</span>
            </div>
          </div>
          <div style={{ textAlign: "center", flexShrink: 0 }}>
            <div style={{ border: "1px solid var(--border-muted)", borderRadius: 6, padding: "10px 16px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>Bridge</div>
              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>agents · PTY</div>
            </div>
          </div>
        </div>

        {/* Three steps */}
        <div style={{ marginTop: 56, width: "100%", maxWidth: 960 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-muted)",
              marginBottom: 16,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              textAlign: "center",
            }}
          >
            Three steps, no SSH
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 16,
            }}
          >
            {STEPS.map((s) => (
              <div
                key={s.n}
                style={{
                  padding: "20px 22px",
                  background: "var(--bg-surface)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 8,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 800,
                    fontFamily: "var(--font-mono)",
                    color: "var(--accent)",
                    border: "1px solid var(--border-muted)",
                    borderRadius: 6,
                    width: 28,
                    height: 28,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    marginBottom: 12,
                    textShadow: "0 0 12px var(--accent-glow)",
                  }}
                >
                  {s.n}
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>{s.title}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Stats row */}
        <div
          style={{
            marginTop: 40,
            width: "100%",
            maxWidth: 960,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 16,
            padding: "24px 0",
            borderTop: "1px solid var(--border-subtle)",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          {STATS.map((s) => (
            <div key={s.label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: "var(--accent)", textShadow: "0 0 16px var(--accent-glow)", fontFamily: "var(--font-mono)" }}>{s.value}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Desktop demo — full width */}
        <div style={{ marginTop: 48, width: "100%", maxWidth: 960 }}>
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

        {/* Features */}
        <div style={{ marginTop: 56, width: "100%", maxWidth: 960 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--text-muted)",
              marginBottom: 16,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              textAlign: "center",
            }}
          >
            Capabilities
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 16,
            }}
          >
            {FEATURES.map((f) => (
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
        </div>

        {/* Closing CTA */}
        <div
          style={{
            marginTop: 64,
            width: "100%",
            maxWidth: 720,
            textAlign: "center",
            padding: "40px 32px",
            background: "var(--bg-surface)",
            border: "1px solid var(--border-muted)",
            borderRadius: 12,
            boxShadow: "0 0 32px color-mix(in srgb, var(--accent) 8%, transparent)",
          }}
        >
          <h2
            style={{
              fontSize: "clamp(22px, 4vw, 32px)",
              fontWeight: 800,
              color: "var(--text-primary)",
              letterSpacing: "-0.02em",
              marginBottom: 12,
            }}
          >
            Start your{" "}
            <span style={{ color: "var(--accent)", textShadow: "0 0 24px var(--accent-glow)" }}>swarm</span>
          </h2>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, maxWidth: 460, margin: "0 auto 24px" }}>
            Self-host it free, or try the hosted version while it&apos;s open. Drive your agents
            from any browser in minutes.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
            <Link
              href="/register"
              className="btn-accent"
              style={{ fontSize: 13, padding: "10px 24px", textDecoration: "none", display: "inline-block" }}
            >
              Self-host (Open Source)
            </Link>
            <Link
              href="/register"
              className="btn-ghost"
              style={{ fontSize: 13, padding: "10px 24px", textDecoration: "none", display: "inline-block", border: "1px solid var(--accent)", color: "var(--accent)" }}
            >
              Try Hosted — Free for limited time
            </Link>
          </div>
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
