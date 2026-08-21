import type { ShellType } from "@/types";

const HARNESS_LABELS = {
  claude: "Claude",
  cursor: "Cursor",
  codex: "Codex",
  shell: "Shell",
  zai: "Z.ai",
  kimi: "Kimi",
  opencode: "OpenCode",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  grok: "Grok",
  pi: "Pi",
  "kimi-code": "Kimi Code",
} satisfies Record<ShellType, string>;

const HARNESS_COLORS = {
  claude: "var(--harness-claude)",
  cursor: "var(--harness-cursor)",
  codex: "var(--harness-codex)",
  shell: "var(--harness-shell)",
  zai: "var(--harness-zai)",
  kimi: "var(--harness-kimi)",
  opencode: "var(--harness-opencode)",
  deepseek: "var(--harness-deepseek)",
  fireworks: "var(--harness-fireworks)",
  grok: "var(--harness-grok)",
  pi: "var(--harness-pi)",
  "kimi-code": "var(--harness-kimi-code)",
} satisfies Record<ShellType, string>;

export function harnessLabel(harness?: ShellType): string {
  if (!harness) return "Agent";
  return HARNESS_LABELS[harness];
}

function HarnessGlyph({ harness }: { harness?: ShellType }) {
  switch (harness) {
    case "claude":
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
          <path d="M10 1.8v4.1M10 14.1v4.1M1.8 10h4.1M14.1 10h4.1M4.2 4.2l2.9 2.9M12.9 12.9l2.9 2.9M15.8 4.2l-2.9 2.9M7.1 12.9l-2.9 2.9" strokeWidth="2.1" />
          <circle cx="10" cy="10" r="2.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "fireworks":
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
          <path d="M10 9.5 5.2 3.1M10 9.5l5.7-5.2M10 9.5l6.9 2.1M10 9.5l2.5 7M10 9.5l-3.7 6.2M10 9.5l-7 .6" strokeWidth="1.7" />
          <circle cx="10" cy="9.5" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "zai":
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="10" cy="10" r="7.2" strokeWidth="1.5" />
          <path d="M6.2 6.7h7.6l-7.5 6.6h7.5" strokeWidth="1.8" />
        </svg>
      );
    case "cursor":
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 2.8 16.2 10 10.5 12l-2.2 5.2L4 2.8Z" strokeWidth="1.8" />
        </svg>
      );
    case "codex":
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m10 2 3.2 1.8 3.3 1.9v3.7L16.4 13l-3.2 1.9-3.2 1.8-3.2-1.8L3.5 13V9.4l.1-3.7 3.2-1.9L10 2Z" strokeWidth="1.45" />
          <path d="m6.8 3.8 6.4 3.7v7.4M3.5 9.4l6.5 3.7 6.5-3.7M10 2v7.4" strokeWidth="1.25" />
        </svg>
      );
    case "pi":
      return <span aria-hidden="true" className="font-serif text-[17px] font-semibold leading-none">π</span>;
    case "shell":
      return <span aria-hidden="true" className="font-mono text-[9px] font-bold leading-none">&gt;_</span>;
    case "opencode":
      return <span aria-hidden="true" className="font-mono text-[10px] font-bold leading-none">&lt;/&gt;</span>;
    case "grok":
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
          <path d="M4 4.2 15.8 16M15.5 4.5 9.2 10.8" strokeWidth="2" />
        </svg>
      );
    case "kimi":
    case "kimi-code":
      return (
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M15.8 13.1A6.7 6.7 0 0 1 7 4.2a6.8 6.8 0 1 0 8.8 8.9Z" />
        </svg>
      );
    case "deepseek":
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
          <path d="M2.5 12.7c3.6-5.6 6.6 2.7 10.4-3.2 1.4-2.1 2.9-2.2 4.6-1.1M3.7 15.5c2.2-2.7 4.6-2.4 6.5-.2" strokeWidth="1.8" />
        </svg>
      );
    default:
      return <span aria-hidden="true" className="font-mono text-[10px] font-semibold leading-none">A</span>;
  }
}

interface HarnessIconProps {
  harness?: ShellType;
  size?: number;
  className?: string;
  title?: string;
}

/** Compact, accessible harness mark for sidebar rows. */
export function HarnessIcon({ harness, size = 18, className = "", title }: HarnessIconProps) {
  const label = harnessLabel(harness);
  const color = harness ? HARNESS_COLORS[harness] : "var(--text-muted)";

  return (
    <span
      role="img"
      aria-label={`${label} agent`}
      title={title ?? `${label} agent`}
      className={`inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size, color }}
    >
      <HarnessGlyph harness={harness} />
    </span>
  );
}
