"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { SessionMessage, ClaudeStreamEvent } from "@/types";

interface SessionStreamProps {
  messages: SessionMessage[];
  isStreaming: boolean;
  sessionName: string | null;
}

interface ParsedMessage {
  type: "text" | "tool_use" | "tool_result" | "status" | "result" | "hidden";
  content: string;
  toolName?: string;
  timestamp: string;
  cost?: number;
  duration?: number;
  raw?: ClaudeStreamEvent;
}

function parseRawEvent(msg: SessionMessage): ParsedMessage {
  const raw = msg.raw;
  const base = { timestamp: msg.timestamp, raw };

  if (!raw) {
    if (msg.content) {
      return { ...base, type: "text", content: msg.content };
    }
    return { ...base, type: "hidden", content: "" };
  }

  switch (raw.type) {
    case "assistant": {
      const text = raw.content_block?.text ?? "";
      if (!text) return { ...base, type: "hidden", content: "" };
      return { ...base, type: "text", content: text };
    }

    case "content_block_delta": {
      const text = raw.delta?.text ?? raw.delta?.partial_json ?? "";
      if (!text) return { ...base, type: "hidden", content: "" };
      return { ...base, type: "text", content: text };
    }

    case "content_block_start": {
      if (raw.content_block?.type === "tool_use") {
        const toolName = raw.content_block.name ?? "unknown";
        return { ...base, type: "tool_use", content: toolName, toolName };
      }
      return { ...base, type: "hidden", content: "" };
    }

    case "tool_use": {
      const toolName = raw.content_block?.name ?? raw.tool_name ?? "unknown";
      return { ...base, type: "tool_use", content: toolName, toolName };
    }

    case "tool_result": {
      const content = raw.result ?? "";
      if (!content) return { ...base, type: "hidden", content: "" };
      return { ...base, type: "tool_result", content };
    }

    case "result": {
      return {
        ...base,
        type: "result",
        content: raw.result ?? "Completed",
        cost: raw.cost_usd,
        duration: raw.duration_ms,
      };
    }

    case "system": {
      if (raw.subtype === "task_progress") {
        const desc = raw.description as string | undefined;
        const lastTool = raw.last_tool_name as string | undefined;
        if (desc) return { ...base, type: "status", content: desc };
        if (lastTool) return { ...base, type: "status", content: `Using ${lastTool}...` };
        return { ...base, type: "status", content: "Working..." };
      }
      if (raw.subtype === "init") {
        const model = raw.model as string | undefined;
        return { ...base, type: "status", content: `Session started${model ? ` (${model})` : ""}` };
      }
      return { ...base, type: "hidden", content: "" };
    }

    case "content_block_stop":
    case "message_start":
    case "message_delta":
    case "message_stop":
      return { ...base, type: "hidden", content: "" };

    default:
      return { ...base, type: "hidden", content: "" };
  }
}

interface MergedBlock {
  type: "text" | "tool_use" | "tool_result" | "status" | "result";
  content: string;
  toolName?: string;
  timestamp: string;
  cost?: number;
  duration?: number;
  raw?: ClaudeStreamEvent;
}

function mergeMessages(messages: SessionMessage[]): MergedBlock[] {
  const blocks: MergedBlock[] = [];

  for (const msg of messages) {
    const parsed = parseRawEvent(msg);
    if (parsed.type === "hidden") continue;

    const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;

    if (parsed.type === "text" && last?.type === "text") {
      last.content += parsed.content;
      last.timestamp = parsed.timestamp;
      continue;
    }


    blocks.push({
      type: parsed.type,
      content: parsed.content,
      toolName: parsed.toolName,
      timestamp: parsed.timestamp,
      cost: parsed.cost,
      duration: parsed.duration,
      raw: parsed.raw,
    });
  }

  return blocks;
}

function TextBlock({ block, isLast, isStreaming }: { block: MergedBlock; isLast: boolean; isStreaming: boolean }) {
  return (
    <div className="px-3 py-2">
      <pre className="text-sm whitespace-pre-wrap break-words text-[var(--text-primary)] leading-relaxed">
        {block.content}
        {isLast && isStreaming && (
          <span className="inline-block w-2 h-4 bg-[var(--accent)] animate-pulse ml-0.5 align-middle" />
        )}
      </pre>
    </div>
  );
}

function ToolUseBlock({ block }: { block: MergedBlock }) {
  const [expanded, setExpanded] = useState(false);
  const input = block.raw?.content_block?.input;

  return (
    <div className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-[rgba(0,187,255,0.06)] border-l-2 border-[#00bbff]">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex items-center gap-2 w-full text-left"
      >
        <span className="text-xs text-[#00bbff] opacity-60">{expanded ? "▼" : "▶"}</span>
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[10px] font-semibold bg-[rgba(0,187,255,0.12)] text-[#00bbff]">
          <span aria-hidden>⚙</span> TOOL
        </span>
        <span className="text-xs text-[#66ccff]">{block.toolName ?? block.content}</span>
        <span className="text-xs text-[var(--text-faint)] ml-auto tabular-nums">{new Date(block.timestamp).toLocaleTimeString()}</span>
      </button>
      {expanded && block.raw && (
        <pre className="text-xs whitespace-pre-wrap break-words text-[#7fb8d6] leading-relaxed mt-2 max-h-60 overflow-y-auto bg-[var(--bg-base)] rounded-[var(--radius-sm)] p-2">
          {input ? JSON.stringify(input, null, 2) : JSON.stringify(block.raw, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultBlock({ block }: { block: MergedBlock }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = block.content.length > 200;
  const preview = truncated ? block.content.slice(0, 200) + "..." : block.content;
  const hiddenChars = block.content.length - 200;

  return (
    <div className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-base)] border-l-2 border-[var(--border-strong)]">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex items-center gap-2 w-full text-left"
      >
        <span className="text-xs text-[var(--text-faint)] opacity-60">{expanded ? "▼" : "▶"}</span>
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[10px] font-semibold bg-[var(--bg-overlay)] text-[var(--text-muted)]">
          <span aria-hidden>←</span> RESULT
        </span>
        {!expanded && (
          <span className="text-xs text-[var(--text-muted)] truncate">{preview}</span>
        )}
        {!expanded && truncated && (
          <span className="text-[10px] text-[var(--text-faint)] shrink-0 ml-auto tabular-nums">+{hiddenChars} chars</span>
        )}
      </button>
      {expanded && (
        <pre className="text-xs whitespace-pre-wrap break-words text-[var(--text-muted)] leading-relaxed mt-2 max-h-80 overflow-y-auto bg-[var(--bg-void)] rounded-[var(--radius-sm)] p-2">
          {block.content}
        </pre>
      )}
    </div>
  );
}

function StatusBlock({ block, isLast, isStreaming }: { block: MergedBlock; isLast: boolean; isStreaming: boolean }) {
  const isActive = isLast && isStreaming;
  return (
    <div className="px-3 py-1 flex items-center gap-2">
      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-[var(--status-pending)] animate-pulse" : "bg-[var(--status-done)]"}`} />
      <span className={`text-xs italic ${isActive ? "text-[var(--status-pending)]" : "text-[var(--text-faint)]"}`}>{block.content}</span>
    </div>
  );
}

function ResultBlock({ block }: { block: MergedBlock }) {
  const meta: string[] = [];
  if (block.duration !== undefined) meta.push(`${(block.duration / 1000).toFixed(1)}s`);
  if (block.cost !== undefined) meta.push(`$${block.cost.toFixed(4)}`);

  // `is_error` / an error subtype is available via the event's index signature
  // without any type change — branch to a failure treatment when present.
  const isError =
    block.raw?.is_error === true ||
    (typeof block.raw?.subtype === "string" && block.raw.subtype.includes("error"));

  if (isError) {
    return (
      <div className="px-3 py-2 rounded-[var(--radius-sm)] bg-[rgba(255,68,102,0.08)] border-l-2 border-[var(--status-error)]">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[10px] font-semibold bg-[rgba(255,68,102,0.12)] text-[var(--status-error)]">
            <span aria-hidden>✗</span> FAILED
          </span>
          {meta.length > 0 && (
            <span className="text-xs text-[var(--status-error)] opacity-70">{meta.join(" | ")}</span>
          )}
        </div>
        <pre className="text-sm whitespace-pre-wrap break-words text-[var(--text-primary)] leading-relaxed mt-1">
          {block.content}
        </pre>
      </div>
    );
  }

  return (
    <div className="px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--accent-dim)] border-l-2 border-[var(--accent)]">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[10px] font-semibold bg-[var(--accent-dim)] text-[var(--accent)]">
          <span aria-hidden>✓</span> DONE
        </span>
        {meta.length > 0 && (
          <span className="text-xs text-[var(--accent)] opacity-70">{meta.join(" | ")}</span>
        )}
      </div>
      <pre className="text-sm whitespace-pre-wrap break-words text-[var(--text-primary)] leading-relaxed mt-1">
        {block.content}
      </pre>
    </div>
  );
}

export function SessionStream({ messages, isStreaming, sessionName }: SessionStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => mergeMessages(messages), [messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [blocks]);

  if (!sessionName) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center" style={{ animation: "fade-in 0.3s ease-out" }}>
          <span
            aria-hidden
            className="w-10 h-10 flex items-center justify-center rounded-[var(--radius-md)] border border-[var(--border-muted)] text-lg text-[var(--text-faint)]"
          >
            ›_
          </span>
          <p className="text-[var(--text-muted)] text-sm">No session selected</p>
          <p className="text-[var(--text-faint)] text-xs">Select a session from the sidebar or create a new one</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2 border-b border-[var(--border-default)] bg-[var(--bg-surface)] flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--text-primary)] truncate">{sessionName}</span>
        {isStreaming && (
          <span className="flex items-center gap-2 text-xs text-[var(--accent)]" aria-live="polite">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
            streaming...
          </span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1">
        {blocks.length === 0 && isStreaming && (
          <div className="flex items-center gap-2 py-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-pending)] animate-pulse" />
            <span className="text-sm text-[var(--status-pending)] italic">Thinking...</span>
          </div>
        )}

        {blocks.length === 0 && !isStreaming && (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center" style={{ animation: "fade-in 0.3s ease-out" }}>
            <span aria-hidden className="text-2xl text-[var(--text-faint)]">›_</span>
            <p className="text-[var(--text-muted)] text-sm">Waiting for messages…</p>
          </div>
        )}

        {blocks.map((block, idx) => {
          const isLast = idx === blocks.length - 1;
          switch (block.type) {
            case "text":
              return <TextBlock key={idx} block={block} isLast={isLast} isStreaming={isStreaming} />;
            case "tool_use":
              return <ToolUseBlock key={idx} block={block} />;
            case "tool_result":
              return <ToolResultBlock key={idx} block={block} />;
            case "status":
              return <StatusBlock key={idx} block={block} isLast={isLast} isStreaming={isStreaming} />;
            case "result":
              return <ResultBlock key={idx} block={block} />;
          }
        })}
      </div>
    </div>
  );
}
