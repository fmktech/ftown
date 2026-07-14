import type { SessionStatus } from "@/types";
import type { ConnectionStatus } from "@/hooks/useCentrifugo";

/** Anything the app renders a themed status dot for. */
export type StatusDotKind = SessionStatus | ConnectionStatus;

const DOT: Record<StatusDotKind, { cls: string; pulse: string }> = {
  running:      { cls: "status-dot-running", pulse: "animate-running" },
  pending:      { cls: "status-dot-pending", pulse: "animate-pending" },
  completed:    { cls: "status-dot-done",    pulse: "" },
  error:        { cls: "status-dot-error",   pulse: "" },
  disconnected: { cls: "status-dot-done",    pulse: "" },
  connected:    { cls: "status-dot-running", pulse: "" },
  connecting:   { cls: "status-dot-pending", pulse: "animate-pending" },
};

/**
 * Full class string for a themed status dot (globals.css `status-dot-*`).
 * Pass `pulse: false` to suppress the default animation for that kind.
 */
export function statusDotClass(kind: StatusDotKind, pulse?: boolean): string {
  const entry = DOT[kind] ?? DOT.completed;
  const pulseCls = pulse === false ? "" : entry.pulse;
  return `status-dot ${entry.cls}${pulseCls ? ` ${pulseCls}` : ""}`;
}

/** The app-standard themed status dot. */
export function StatusDot({
  kind,
  pulse,
  title,
}: {
  kind: StatusDotKind;
  /** Override the kind's default pulse animation. */
  pulse?: boolean;
  title?: string;
}) {
  return (
    <span
      className={statusDotClass(kind, pulse)}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  );
}
