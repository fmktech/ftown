import type { SessionActivity } from "@/hooks/useAllSessionEvents";
import { StatusDot } from "@/lib/StatusDot";
import type { SessionStatus } from "@/types";

type Activity = SessionActivity["activity"];

const TERMINAL_STATE_LABELS = {
  completed: "Completed",
  disconnected: "Disconnected",
  pending: "Pending",
  error: "Error",
} satisfies Record<Exclude<SessionStatus, "running">, string>;

function sessionStateLabel(
  status: SessionStatus,
  activity?: Activity,
  needsInput = false,
): string {
  if (needsInput) return "Input needed";
  if (status === "running" && (activity === "thinking" || activity === "tool_use")) {
    return activity === "tool_use" ? "Using a tool" : "Thinking";
  }
  if (status === "running" && activity === "idle") return "Idle";
  if (status === "running") return "Running";
  return TERMINAL_STATE_LABELS[status];
}

interface SessionStateIndicatorProps {
  status: SessionStatus;
  activity?: Activity;
  needsInput?: boolean;
}

/** Icon-only live state used by compact session and factory rows. */
export function SessionStateIndicator({
  status,
  activity,
  needsInput = false,
}: SessionStateIndicatorProps) {
  const label = sessionStateLabel(status, activity, needsInput);

  if (needsInput) {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-amber-400"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.4 3.2h11.2v7.5H8l-3.2 2.2v-2.2H2.4V3.2Z" strokeWidth="1.4" />
          <path d="M6.6 5.8c.2-.7.7-1 1.4-1 .9 0 1.5.5 1.5 1.2 0 1.1-1.3 1.1-1.3 2" strokeWidth="1.2" />
          <circle cx="8.2" cy="9.2" r=".65" fill="currentColor" stroke="none" />
        </svg>
      </span>
    );
  }

  if (status === "running" && (activity === "thinking" || activity === "tool_use")) {
    return (
      <span
        role="status"
        aria-label={label}
        title={label}
        className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-emerald-900 border-t-emerald-400"
      />
    );
  }

  if (status === "running" && activity === "idle") {
    return <StatusDot kind="pending" pulse={false} title={label} />;
  }

  return <StatusDot kind={status} pulse={false} title={label} />;
}
