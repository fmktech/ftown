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
      <pre className="text-sm whitespace-pre-wrap break-words text-[#e0e0e0] leading-relaxed">
        {block.content}
        {isLast && isStreaming && (
          <span className="inline-block w-2 h-4 bg-[#00ff88] animate-pulse ml-0.5 align-middle" />
        )}
      </pre>
    </div>
  );
}

function ToolUseBlock({ block }: { block: MergedBlock }) {
  const [expanded, setExpanded] = useState(false);
  const input = block.raw?.content_block?.input;

  return (
    <div className="px-3 py-1.5 bg-[#001a2e] rounded border-l-2 border-[#00bbff]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span className="text-xs text-[#00bbff] opacity-50">{expanded ? "▼" : "▶"}</span>
        <span className="text-xs font-bold text-[#00bbff] opacity-70">[TOOL]</span>
        <span className="text-xs text-[#00bbff]">{block.toolName ?? block.content}</span>
        <span className="text-xs text-[#333] ml-auto">{new Date(block.timestamp).toLocaleTimeString()}</span>
      </button>
      {expanded && block.raw && (
        <pre className="text-xs whitespace-pre-wrap break-words text-[#4a8ab5] leading-relaxed mt-2 max-h-60 overflow-y-auto bg-[#00101a] rounded p-2">
          {input ? JSON.stringify(input, null, 2) : JSON.stringify(block.raw, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ToolResultBlock({ block }: { block: MergedBlock }) {
  const [expanded, setExpanded] = useState(false);
  const preview = block.content.length > 200 ? block.content.slice(0, 200) + "..." : block.content;

  return (
    <div className="px-3 py-1.5 bg-[#0a0a0a] rounded border-l-2 border-[#333]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
      >
        <span className="text-xs text-[#555] opacity-50">{expanded ? "▼" : "▶"}</span>
        <span className="text-xs font-bold text-[#555] opacity-70">[RESULT]</span>
        {!expanded && (
          <span className="text-xs text-[#555] truncate">{preview}</span>
        )}
      </button>
      {expanded && (
        <pre className="text-xs whitespace-pre-wrap break-words text-[#666] leading-relaxed mt-2 max-h-80 overflow-y-auto bg-[#050505] rounded p-2">
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
      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-[#ffcc00] animate-pulse" : "bg-[#444]"}`} />
      <span className={`text-xs italic ${isActive ? "text-[#ffcc00]" : "text-[#555]"}`}>{block.content}</span>
    </div>
  );
}

function ResultBlock({ block }: { block: MergedBlock }) {
  const meta: string[] = [];
  if (block.duration !== undefined) meta.push(`${(block.duration / 1000).toFixed(1)}s`);
  if (block.cost !== undefined) meta.push(`$${block.cost.toFixed(4)}`);

  return (
    <div className="px-3 py-2 bg-[#0a1a0a] rounded border-l-2 border-[#00ff88]">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-[#00ff88]">[DONE]</span>
        {meta.length > 0 && (
          <span className="text-xs text-[#00ff88] opacity-60">{meta.join(" | ")}</span>
        )}
      </div>
      <pre className="text-sm whitespace-pre-wrap break-words text-[#e0e0e0] leading-relaxed mt-1">
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
      <div className="flex-1 flex items-center justify-center text-[#555]">
        <div className="text-center">
          <p className="text-lg mb-2">No session selected</p>
          <p className="text-sm">Select a session from the sidebar or create a new one</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2 border-b border-[#2a2a2a] bg-[#111111] flex items-center justify-between">
        <span className="text-sm font-medium text-[#e0e0e0]">{sessionName}</span>
        {isStreaming && (
          <span className="flex items-center gap-2 text-xs text-[#00ff88]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00ff88] animate-pulse" />
            streaming...
          </span>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1">
        {blocks.length === 0 && isStreaming && (
          <div className="flex items-center gap-2 py-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[#ffcc00] animate-pulse" />
            <span className="text-sm text-[#ffcc00] italic">Thinking...</span>
          </div>
        )}

        {blocks.length === 0 && !isStreaming && (
          <p className="text-[#555] text-sm">Waiting for messages...</p>
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
