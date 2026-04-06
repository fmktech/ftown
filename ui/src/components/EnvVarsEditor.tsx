"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

// ---------------------------------------------------------------------------
// Known env-var catalogue
// ---------------------------------------------------------------------------

interface EnvVarDef {
  name: string;
  description: string;
}

interface EnvVarCategory {
  label: string;
  vars: EnvVarDef[];
}

const ENV_VAR_CATALOGUE: EnvVarCategory[] = [
  {
    label: "Authentication & API",
    vars: [
      { name: "ANTHROPIC_API_KEY", description: "API key for X-Api-Key header" },
      { name: "ANTHROPIC_AUTH_TOKEN", description: "Custom Authorization header value (prefixed with Bearer)" },
      { name: "ANTHROPIC_BASE_URL", description: "Override API endpoint for proxy/gateway" },
      { name: "ANTHROPIC_BETAS", description: "Comma-separated beta header values" },
      { name: "ANTHROPIC_CUSTOM_HEADERS", description: "Custom headers (Name: Value format)" },
    ],
  },
  {
    label: "Model Configuration",
    vars: [
      { name: "ANTHROPIC_CUSTOM_MODEL_OPTION", description: "Custom model ID for /model picker" },
      { name: "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", description: "Display name for custom model" },
      { name: "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION", description: "Description for custom model" },
      { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", description: "Override default Haiku model" },
      { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME", description: "Display name for Haiku" },
      { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION", description: "Description for Haiku" },
      { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES", description: "Capabilities for Haiku" },
      { name: "ANTHROPIC_DEFAULT_OPUS_MODEL", description: "Override default Opus model" },
      { name: "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME", description: "Display name for Opus" },
      { name: "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION", description: "Description for Opus" },
      { name: "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES", description: "Capabilities for Opus" },
      { name: "ANTHROPIC_DEFAULT_SONNET_MODEL", description: "Override default Sonnet model" },
      { name: "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME", description: "Display name for Sonnet" },
      { name: "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION", description: "Description for Sonnet" },
      { name: "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES", description: "Capabilities for Sonnet" },
      { name: "ANTHROPIC_MODEL", description: "Override default model" },
      { name: "CLAUDE_CODE_SUBAGENT_MODEL", description: "Override model for subagents" },
      { name: "CLAUDE_CODE_FALLBACK_MODEL", description: "Fallback model after overload errors" },
    ],
  },
  {
    label: "Cloud Providers (Bedrock/Vertex/Foundry)",
    vars: [
      { name: "ANTHROPIC_BEDROCK_BASE_URL", description: "Override Bedrock endpoint" },
      { name: "CLAUDE_CODE_USE_BEDROCK", description: "Use Amazon Bedrock (set to 1)" },
      { name: "CLAUDE_CODE_USE_VERTEX", description: "Use Google Cloud Vertex AI (set to 1)" },
      { name: "CLAUDE_CODE_USE_FOUNDRY", description: "Use Microsoft Foundry" },
      { name: "CLAUDE_CODE_SKIP_BEDROCK_AUTH", description: "Skip Bedrock authentication" },
      { name: "CLAUDE_CODE_SKIP_VERTEX_AUTH", description: "Skip Vertex authentication" },
      { name: "CLAUDE_CODE_SKIP_FOUNDRY_AUTH", description: "Skip Foundry authentication" },
    ],
  },
  {
    label: "Feature Flags & Behavior",
    vars: [
      { name: "CLAUDE_CODE_DISABLE_FAST_MODE", description: "Disable fast mode (set to 1)" },
      { name: "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", description: "Disable quality surveys" },
      { name: "CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING", description: "Disable file checkpointing" },
      { name: "CLAUDE_CODE_DISABLE_MOUSE", description: "Disable mouse tracking in fullscreen" },
      { name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", description: "Disable autoupdater, feedback, error reporting, telemetry" },
      { name: "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK", description: "Disable non-streaming fallback" },
      { name: "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", description: "Strip credentials from subprocess envs (set to 1)" },
      { name: "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", description: "Disable built-in subagent types" },
      { name: "DISABLE_AUTOUPDATER", description: "Disable auto-updater" },
      { name: "DISABLE_ERROR_REPORTING", description: "Disable error reporting" },
      { name: "DISABLE_TELEMETRY", description: "Disable telemetry" },
      { name: "FORCE_AUTOUPDATE_PLUGINS", description: "Force plugin auto-updates" },
      { name: "CLAUDE_CODE_COORDINATOR_MODE", description: "Enable coordinator mode for multi-agent orchestration" },
    ],
  },
  {
    label: "Session & Runtime",
    vars: [
      { name: "CLAUDE_ENV_FILE", description: "Path to shell script sourced before each Bash command" },
      { name: "CLAUDE_CODE_ENABLE_STREAM_IDLE_TIMEOUT", description: "Enable stream idle timeout" },
      { name: "CLAUDE_STREAM_IDLE_TIMEOUT_MS", description: "Stream idle timeout in milliseconds" },
      { name: "CLAUDE_CODE_MAX_TURNS", description: "Max turns in non-interactive mode" },
      { name: "CLAUDE_CODE_MAX_OUTPUT_TOKENS", description: "Max output tokens per request" },
      { name: "ENABLE_TOOL_SEARCH", description: "Enable MCP tool search with proxy" },
    ],
  },
  {
    label: "Telemetry & Monitoring (OpenTelemetry)",
    vars: [
      { name: "OTEL_METRICS_EXPORTER", description: "OTel metrics exporter" },
      { name: "OTEL_LOGS_EXPORTER", description: "OTel logs exporter" },
      { name: "OTEL_EXPORTER_OTLP_ENDPOINT", description: "OTel OTLP endpoint" },
      { name: "OTEL_EXPORTER_OTLP_PROTOCOL", description: "OTel OTLP protocol" },
      { name: "OTEL_EXPORTER_OTLP_HEADERS", description: "OTel OTLP headers" },
      { name: "OTEL_METRIC_EXPORT_INTERVAL", description: "OTel metric export interval" },
      { name: "OTEL_RESOURCE_ATTRIBUTES", description: "OTel resource attributes" },
    ],
  },
  {
    label: "Network & Proxy",
    vars: [
      { name: "HTTP_PROXY", description: "HTTP proxy" },
      { name: "HTTPS_PROXY", description: "HTTPS proxy" },
      { name: "NO_PROXY", description: "Proxy bypass list" },
    ],
  },
];

const ALL_VAR_NAMES: string[] = ENV_VAR_CATALOGUE.flatMap((c) => c.vars.map((v) => v.name));

const SENSITIVE_PATTERNS = ["API_KEY", "AUTH_TOKEN", "PASSWORD", "SECRET"];

function isSensitive(name: string): boolean {
  const upper = name.toUpperCase();
  return SENSITIVE_PATTERNS.some((p) => upper.includes(p));
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ftown:envVars";

export function getStoredEnvVars(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function setStoredEnvVars(vars: Record<string, string>): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(vars));
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`}
    >
      <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MaskedValue({ value, name }: { value: string; name: string }) {
  const [revealed, setRevealed] = useState(false);
  const sensitive = isSensitive(name);

  if (!sensitive || revealed) {
    return (
      <span
        className="font-mono text-sm text-[#e0e0e0] truncate cursor-default select-all"
        onClick={() => sensitive && setRevealed(false)}
        title={sensitive ? "Click to mask" : undefined}
      >
        {value}
      </span>
    );
  }

  return (
    <span
      className="font-mono text-sm text-[#888888] cursor-pointer select-none tracking-widest"
      onClick={() => setRevealed(true)}
      title="Click to reveal"
    >
      {"●".repeat(Math.min(value.length, 24))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Searchable combobox dropdown
// ---------------------------------------------------------------------------

interface ComboboxProps {
  value: string;
  onChange: (val: string) => void;
  existingKeys: Set<string>;
}

function VarNameCombobox({ value, onChange, existingKeys }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync external value into local search text
  useEffect(() => {
    setSearch(value);
  }, [value]);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(() => {
    const q = search.toUpperCase().trim();
    return ENV_VAR_CATALOGUE.map((cat) => ({
      label: cat.label,
      vars: cat.vars.filter(
        (v) =>
          !existingKeys.has(v.name) &&
          (q === "" || v.name.includes(q) || v.description.toUpperCase().includes(q))
      ),
    })).filter((cat) => cat.vars.length > 0);
  }, [search, existingKeys]);

  const handleSelect = useCallback(
    (name: string) => {
      onChange(name);
      setSearch(name);
      setOpen(false);
    },
    [onChange]
  );

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0">
      <input
        ref={inputRef}
        type="text"
        value={search}
        placeholder="Variable name..."
        className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] font-mono focus:outline-none focus:border-[#00ff88] placeholder:text-[#555]"
        onChange={(e) => {
          const v = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "");
          setSearch(v);
          onChange(v);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 left-0 right-0 top-full mt-1 max-h-64 overflow-y-auto bg-[#111111] border border-[#2a2a2a] rounded shadow-lg">
          {filtered.map((cat) => (
            <div key={cat.label}>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[#00ff88] bg-[#0a0a0a] sticky top-0 font-semibold">
                {cat.label}
              </div>
              {cat.vars.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  className="w-full text-left px-3 py-1.5 hover:bg-[#1a1a1a] cursor-pointer transition-colors"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect(v.name);
                  }}
                >
                  <span className="font-mono text-xs text-[#e0e0e0]">{v.name}</span>
                  <span className="block text-[11px] text-[#555] truncate">{v.description}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface EnvVarsEditorProps {
  value?: Record<string, string>;
  onChange?: (envVars: Record<string, string>) => void;
}

export default function EnvVarsEditor({ value: controlledValue, onChange: controlledOnChange }: EnvVarsEditorProps) {
  const isControlled = controlledValue !== undefined;

  const [internalVars, setInternalVars] = useState<Record<string, string>>(() => {
    if (isControlled) return controlledValue;
    return getStoredEnvVars();
  });

  const vars = isControlled ? controlledValue : internalVars;

  const setVars = useCallback(
    (next: Record<string, string>) => {
      if (isControlled) {
        controlledOnChange?.(next);
      } else {
        setInternalVars(next);
        setStoredEnvVars(next);
      }
    },
    [isControlled, controlledOnChange]
  );

  // Sync controlled value into internal state
  useEffect(() => {
    if (isControlled && controlledValue) {
      setInternalVars(controlledValue);
    }
  }, [isControlled, controlledValue]);

  const [collapsed, setCollapsed] = useState(true);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");

  const existingKeys = useMemo(() => new Set(Object.keys(vars)), [vars]);
  const count = Object.keys(vars).length;

  const handleAdd = useCallback(() => {
    const trimmedName = newName.trim();
    const trimmedValue = newValue.trim();
    if (!trimmedName || !trimmedValue) return;
    const next = { ...vars, [trimmedName]: trimmedValue };
    setVars(next);
    setNewName("");
    setNewValue("");
  }, [newName, newValue, vars, setVars]);

  const handleDelete = useCallback(
    (key: string) => {
      const next = { ...vars };
      delete next[key];
      setVars(next);
    },
    [vars, setVars]
  );

  const handleUpdateValue = useCallback(
    (key: string, val: string) => {
      setVars({ ...vars, [key]: val });
    },
    [vars, setVars]
  );

  const sortedKeys = useMemo(() => {
    const order = new Map<string, number>();
    let idx = 0;
    for (const cat of ENV_VAR_CATALOGUE) {
      for (const v of cat.vars) {
        order.set(v.name, idx++);
      }
    }
    return Object.keys(vars).sort((a, b) => {
      const oa = order.get(a) ?? 99999;
      const ob = order.get(b) ?? 99999;
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b);
    });
  }, [vars]);

  return (
    <div className="border border-[#2a2a2a] rounded bg-[#111111]">
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((p) => !p)}
        className="w-full flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-[#1a1a1a] transition-colors"
      >
        <div className="flex items-center gap-2 text-sm text-[#e0e0e0]">
          <ChevronIcon open={!collapsed} />
          <span>Environment Variables</span>
          {count > 0 && (
            <span className="text-xs text-[#888888] font-mono">({count})</span>
          )}
        </div>
      </button>

      {/* Body */}
      {!collapsed && (
        <div className="border-t border-[#2a2a2a] px-4 py-3 space-y-2">
          {/* Existing vars */}
          {sortedKeys.map((key) => (
            <div key={key} className="flex items-center gap-2 group">
              <span className="font-mono text-xs text-[#00ff88] w-[260px] shrink-0 truncate" title={key}>
                {key}
              </span>
              <div className="flex-1 min-w-0 flex items-center">
                <MaskedValue name={key} value={vars[key]} />
              </div>
              <button
                type="button"
                onClick={() => handleDelete(key)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-[#555] hover:text-red-400 text-sm px-1 cursor-pointer shrink-0"
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}

          {/* Add new row */}
          <div className="flex items-center gap-2 pt-2 border-t border-[#1a1a1a]">
            <VarNameCombobox value={newName} onChange={setNewName} existingKeys={existingKeys} />
            <input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="Value..."
              className="flex-1 min-w-0 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] font-mono focus:outline-none focus:border-[#00ff88] placeholder:text-[#555]"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
              }}
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newName.trim() || !newValue.trim()}
              className="shrink-0 px-3 py-2 rounded text-sm font-bold bg-[#00ff88] text-[#0a0a0a] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer hover:brightness-110 transition-all"
            >
              Add
            </button>
          </div>

          {count === 0 && (
            <p className="text-xs text-[#444] pt-1">
              No environment variables configured. Select or type a variable name above to get started.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
