import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

function GitHubIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
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
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

function ZapIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
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

const linkFocus =
  "rounded-[var(--radius-sm)] outline-none focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]";

function CtaButtons({ align = "start" }: { align?: "start" | "center" }) {
  return (
    <div
      className={`flex flex-col ${align === "center" ? "items-center" : "items-start"} gap-3 w-full`}
    >
      <div
        className={`flex flex-wrap gap-3 ${align === "center" ? "justify-center" : ""}`}
      >
        <Link
          href="/register"
          className={`btn-accent !text-[13px] !px-6 !py-2.5 no-underline inline-block ${linkFocus}`}
        >
          Try Hosted
        </Link>
        <Link
          href="/register"
          className={`btn-ghost !text-[13px] !px-6 !py-2.5 no-underline inline-block ${linkFocus}`}
        >
          Self-host (Open Source)
        </Link>
        <a
          href="https://github.com/fmktech/ftown"
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-2 text-[13px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors no-underline px-1 py-2.5 ${linkFocus}`}
        >
          <GitHubIcon /> GitHub
        </a>
      </div>
      <p className="text-[11px] tracking-[0.04em] uppercase text-[var(--text-faint)]">
        Free during beta — no card required
      </p>
    </div>
  );
}

function DemoVideo({
  src,
  poster,
  label,
  className = "",
}: {
  src: string;
  poster: string;
  label: string;
  className?: string;
}) {
  return (
    <video
      autoPlay
      loop
      muted
      playsInline
      poster={poster}
      aria-label={label}
      className={`rounded-[var(--radius-lg)] border border-[var(--border-muted)] ${className}`}
    >
      <source src={src} type="video/mp4" />
    </video>
  );
}

export default async function LandingPage() {
  const session = await auth();
  if (session?.user?.email) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-[var(--bg-void)] flex flex-col">
      {/* Skip link */}
      <a
        href="#main"
        className={`sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:px-3 focus:py-2 focus:bg-[var(--bg-elevated)] focus:text-[var(--accent)] focus:text-xs ${linkFocus}`}
      >
        Skip to main content
      </a>

      {/* Nav */}
      <nav
        aria-label="Primary"
        className="px-6 py-4 flex items-center justify-between border-b border-[var(--border-subtle)]"
      >
        <span className="text-sm font-extrabold tracking-[0.15em] uppercase text-[var(--accent)] [text-shadow:0_0_12px_var(--accent-glow)]">
          ftown
        </span>
        <div className="flex items-center gap-4">
          <a
            href="https://github.com/fmktech/ftown"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View ftown on GitHub"
            className={`text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors flex items-center ${linkFocus}`}
          >
            <GitHubIcon />
          </a>
          <Link
            href="/login"
            className={`text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] border border-[var(--border-muted)] rounded-[var(--radius-sm)] px-3.5 py-1.5 no-underline transition-colors ${linkFocus}`}
          >
            Sign In
          </Link>
        </div>
      </nav>

      {/* Main */}
      <main
        id="main"
        className="flex-1 flex flex-col items-center px-6 py-12 sm:py-16"
      >
        {/* Hero */}
        <div className="flex flex-col lg:flex-row items-center gap-10 lg:gap-12 w-full max-w-[960px]">
          {/* Left: text + CTAs */}
          <div className="flex-1 min-w-0 w-full">
            <p className="text-[11px] tracking-[0.14em] uppercase text-[var(--accent)] font-semibold mb-4">
              Self-hosted · Open source
            </p>
            <h1 className="font-[family-name:var(--font-sans)] text-[clamp(32px,6vw,64px)] font-bold leading-[1.05] tracking-[-0.02em] text-[var(--text-primary)] mb-5">
              Command every{" "}
              <span className="text-[var(--accent)] [text-shadow:0_0_24px_var(--accent-glow)]">
                coding agent
              </span>{" "}
              from one browser.
            </h1>

            <p className="font-[family-name:var(--font-sans)] text-sm sm:text-base text-[var(--text-secondary)] leading-relaxed max-w-[52ch] mb-6">
              ftown streams Claude Code, Cursor, Codex, opencode, and shells from any
              machine to your desktop or phone — no SSH, no port forwarding. Self-hosted,
              on the subscriptions you already pay for.
            </p>

            <div className="flex flex-wrap gap-2 mb-7 max-w-[520px]">
              {SUPPORTED_AGENTS.map((agent) => (
                <span
                  key={agent.name}
                  className="text-[12px] font-[family-name:var(--font-mono)] px-2.5 py-1 rounded-[var(--radius-sm)] border border-[var(--border-muted)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
                  title={agent.detail}
                >
                  {agent.name}
                </span>
              ))}
              <span className="text-[12px] font-[family-name:var(--font-mono)] px-2.5 py-1 rounded-[var(--radius-sm)] border border-dashed border-[var(--border-muted)] text-[var(--text-faint)]">
                + z.ai · Kimi · DeepSeek · Fireworks via Claude
              </span>
            </div>

            <CtaButtons />
          </div>

          {/* Right: mobile demo */}
          <div className="shrink-0">
            <DemoVideo
              src="/demo-mobile.mp4"
              poster="/demo-mobile-poster.jpg"
              label="Demo of ftown mobile UI"
              className="w-[220px] max-w-full"
            />
          </div>
        </div>

        {/* Stats strip */}
        <div className="mt-12 sm:mt-16 w-full max-w-[960px] grid grid-cols-2 sm:grid-cols-4 gap-6 py-6 border-y border-[var(--border-subtle)]">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div className="text-[28px] font-extrabold font-[family-name:var(--font-mono)] text-[var(--accent)] [text-shadow:0_0_16px_var(--accent-glow)]">
                {s.value}
              </div>
              <div className="text-xs text-[var(--text-muted)] mt-1">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Architecture diagram */}
        <div className="mt-12 sm:mt-16 w-full max-w-[560px] overflow-x-auto">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 sm:gap-0 p-6 sm:px-8 bg-[var(--bg-surface)] border border-[var(--border-muted)] rounded-[var(--radius-md)]">
            <div className="text-center shrink-0 border border-[var(--border-muted)] rounded-[var(--radius-md)] px-4 py-2.5">
              <div className="text-xs font-semibold text-[var(--text-primary)]">Browser</div>
              <div className="text-[11px] text-[var(--text-muted)]">Next.js</div>
            </div>

            <div className="flex flex-row sm:flex-col items-center justify-center gap-1 px-0 sm:px-2 py-1 sm:py-0">
              <span className="text-[11px] text-[var(--text-faint)] whitespace-nowrap">WebSocket</span>
              <span aria-hidden="true" className="text-[var(--text-faint)] text-xs rotate-90 sm:rotate-0">
                ↔
              </span>
            </div>

            <div className="text-center shrink-0 border border-[var(--accent)] rounded-[var(--radius-md)] px-4 py-2.5 shadow-[var(--shadow-glow-accent)]">
              <div className="text-xs font-semibold text-[var(--accent)]">Centrifugo</div>
              <div className="text-[11px] text-[var(--text-muted)]">pub/sub</div>
            </div>

            <div className="flex flex-row sm:flex-col items-center justify-center gap-1 px-0 sm:px-2 py-1 sm:py-0">
              <span className="text-[11px] text-[var(--text-faint)] whitespace-nowrap">WebSocket</span>
              <span aria-hidden="true" className="text-[var(--text-faint)] text-xs rotate-90 sm:rotate-0">
                ↔
              </span>
            </div>

            <div className="text-center shrink-0 border border-[var(--border-muted)] rounded-[var(--radius-md)] px-4 py-2.5">
              <div className="text-xs font-semibold text-[var(--text-primary)]">Bridge</div>
              <div className="text-[11px] text-[var(--text-muted)]">agents · PTY</div>
            </div>
          </div>
        </div>

        {/* How it works */}
        <div className="mt-14 sm:mt-20 w-full max-w-[960px]">
          <div className="text-[11px] font-semibold tracking-[0.08em] uppercase text-[var(--text-muted)] mb-4 text-center">
            Three steps, no SSH
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            {STEPS.map((s) => (
              <div
                key={s.n}
                className="rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-muted)] p-5"
              >
                <div className="text-[13px] font-extrabold font-[family-name:var(--font-mono)] text-[var(--accent)] border border-[var(--border-muted)] rounded-[var(--radius-md)] w-7 h-7 flex items-center justify-center mb-3 [text-shadow:0_0_12px_var(--accent-glow)]">
                  {s.n}
                </div>
                <div className="text-sm font-bold text-[var(--text-primary)] mb-1.5">{s.title}</div>
                <div className="font-[family-name:var(--font-sans)] text-[13px] text-[var(--text-secondary)] leading-relaxed">
                  {s.desc}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Features */}
        <div className="mt-14 sm:mt-20 w-full max-w-[960px]">
          <div className="text-[11px] font-semibold tracking-[0.08em] uppercase text-[var(--text-muted)] mb-4 text-center">
            Capabilities
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-muted)] p-4 sm:p-5 hover:border-[var(--border-strong)] transition-colors"
              >
                <div className="text-[var(--accent)] mb-2">{f.icon}</div>
                <div className="text-[13px] font-bold text-[var(--text-primary)] mb-1">{f.title}</div>
                <div className="font-[family-name:var(--font-sans)] text-[13px] text-[var(--text-secondary)] leading-relaxed">
                  {f.desc}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Desktop demo */}
        <div className="mt-14 sm:mt-20 w-full max-w-[960px]">
          <div className="text-[11px] font-semibold tracking-[0.08em] uppercase text-[var(--text-muted)] mb-2">
            Desktop
          </div>
          <DemoVideo
            src="/demo-desktop.mp4"
            poster="/demo-desktop-poster.jpg"
            label="Demo of ftown desktop UI"
            className="w-full"
          />
        </div>

        {/* Closing CTA */}
        <div className="mt-16 sm:mt-24 w-full max-w-[720px] text-center rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-muted)] px-6 sm:px-8 py-10 shadow-[var(--shadow-glow-accent)]">
          <p className="font-[family-name:var(--font-sans)] text-[13px] text-[var(--text-faint)] mb-4">
            Built by developers tired of SSH-ing into boxes to babysit agents.
          </p>
          <h2 className="font-[family-name:var(--font-sans)] text-[clamp(24px,4vw,36px)] font-bold tracking-[-0.02em] text-[var(--text-primary)] mb-3">
            Start your{" "}
            <span className="text-[var(--accent)] [text-shadow:0_0_24px_var(--accent-glow)]">swarm</span>
          </h2>
          <p className="font-[family-name:var(--font-sans)] text-sm sm:text-base text-[var(--text-secondary)] leading-relaxed max-w-[460px] mx-auto mb-6">
            Self-host it free, or try the hosted version while it&apos;s open. Drive your
            agents from any browser in minutes.
          </p>
          <div className="flex justify-center">
            <CtaButtons align="center" />
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="px-6 py-4 border-t border-[var(--border-subtle)] flex items-center justify-center gap-4">
        <span className="text-xs text-[var(--text-faint)]">MIT License</span>
        <span className="text-[var(--border-muted)]" aria-hidden="true">
          /
        </span>
        <a
          href="https://github.com/fmktech/ftown"
          target="_blank"
          rel="noopener noreferrer"
          className={`text-xs text-[var(--text-faint)] hover:text-[var(--text-secondary)] transition-colors no-underline ${linkFocus}`}
        >
          github.com/fmktech/ftown
        </a>
      </footer>
    </div>
  );
}
