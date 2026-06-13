"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { ShellType } from "@/types";
import { BridgeInfo } from "@/hooks/useBridges";
import { BridgeExecResponse } from "@/hooks/useSessions";
import { ClaudeSessionPicker } from "./ClaudeSessionPicker";
import { CursorSessionPicker } from "./CursorSessionPicker";
import EnvVarsEditor, { getStoredEnvVars } from "./EnvVarsEditor";

export interface SessionDefaults {
  name?: string;
  workingDir?: string;
  bridgeId?: string;
  shellType?: ShellType;
}

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (prompt: string, options: { name?: string; model?: string; workingDir?: string; bridgeId?: string; shellType?: ShellType; claudeSessionId?: string; cursorSessionId?: string; env?: Record<string, string>; orchestrator?: boolean }) => void | Promise<void>;
  bridges: BridgeInfo[];
  defaults?: SessionDefaults;
  bridgeExec: (command: string, workingDir: string, bridgeId: string) => Promise<BridgeExecResponse>;
}

const FIREWORKS_MODELS_KEY = "ftown:fireworksModels";

const FIREWORKS_MODEL_OPTIONS = [
  "accounts/fireworks/models/deepseek-v4-pro",
  "accounts/fireworks/models/kimi-k2p6",
  "accounts/fireworks/models/minimax-m2p7",
  "accounts/fireworks/models/qwen3p6-plus",
  "accounts/fireworks/models/glm-5p1",
  "accounts/fireworks/models/gpt-oss-120b",
] as const;

interface FireworksModels {
  opus: string;
  sonnet: string;
  haiku: string;
}

const FIREWORKS_DEFAULT_MODELS: FireworksModels = {
  opus: "accounts/fireworks/models/kimi-k2p6",
  sonnet: "accounts/fireworks/models/deepseek-v4-pro",
  haiku: "accounts/fireworks/models/gpt-oss-120b",
};

const ZAI_MODELS_KEY = "ftown:zaiModels";

const ZAI_MODEL_OPTIONS = [
  "glm-5.2[1m]",
  "glm-5.2",
  "glm-4.6",
  "glm-4.5-air",
  "glm-4.5",
  "GLM-5.1",
  "GLM-5-Turbo",
  "GLM-4.7-Flash",
] as const;

interface ZaiModels {
  opus: string;
  sonnet: string;
  haiku: string;
}

const ZAI_DEFAULT_MODELS: ZaiModels = {
  opus: "glm-5.2[1m]",
  sonnet: "glm-5.2[1m]",
  haiku: "glm-4.5-air",
};

const AUTO_COMPACT_WINDOW_KEY = "ftown:autoCompactWindow";

const FLAVOR_AUTO_COMPACT_DEFAULTS: Record<"standard" | "zai" | "kimi" | "deepseek" | "fireworks", string> = {
  standard: "",
  zai: "1000000",
  kimi: "256000",
  deepseek: "1000000",
  fireworks: "200000",
};

function getStoredAutoCompactWindow(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(AUTO_COMPACT_WINDOW_KEY) ?? "";
  } catch {
    return "";
  }
}

function setStoredAutoCompactWindow(value: string): void {
  if (typeof window === "undefined") return;
  if (value) {
    localStorage.setItem(AUTO_COMPACT_WINDOW_KEY, value);
  } else {
    localStorage.removeItem(AUTO_COMPACT_WINDOW_KEY);
  }
}

function getStoredFireworksModels(): FireworksModels {
  if (typeof window === "undefined") return FIREWORKS_DEFAULT_MODELS;
  try {
    const raw = localStorage.getItem(FIREWORKS_MODELS_KEY);
    if (!raw) return FIREWORKS_DEFAULT_MODELS;
    const parsed = JSON.parse(raw) as Partial<FireworksModels>;
    return {
      opus: parsed.opus ?? FIREWORKS_DEFAULT_MODELS.opus,
      sonnet: parsed.sonnet ?? FIREWORKS_DEFAULT_MODELS.sonnet,
      haiku: parsed.haiku ?? FIREWORKS_DEFAULT_MODELS.haiku,
    };
  } catch {
    return FIREWORKS_DEFAULT_MODELS;
  }
}

function setStoredFireworksModels(models: FireworksModels): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(FIREWORKS_MODELS_KEY, JSON.stringify(models));
}

function getStoredZaiModels(): ZaiModels {
  if (typeof window === "undefined") return ZAI_DEFAULT_MODELS;
  try {
    const raw = localStorage.getItem(ZAI_MODELS_KEY);
    if (!raw) return ZAI_DEFAULT_MODELS;
    const parsed = JSON.parse(raw) as Partial<ZaiModels>;
    return {
      opus: parsed.opus ?? ZAI_DEFAULT_MODELS.opus,
      sonnet: parsed.sonnet ?? ZAI_DEFAULT_MODELS.sonnet,
      haiku: parsed.haiku ?? ZAI_DEFAULT_MODELS.haiku,
    };
  } catch {
    return ZAI_DEFAULT_MODELS;
  }
}

function setStoredZaiModels(models: ZaiModels): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ZAI_MODELS_KEY, JSON.stringify(models));
}

function getZaiDefaultEnv(models: ZaiModels): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
    ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet,
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
  };
}

function getKimiDefaultEnv(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "256000",
  };
}

function getDeepseekDefaultEnv(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
  };
}

function getFireworksDefaultEnv(models: FireworksModels): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: "https://api.fireworks.ai/inference",
    ANTHROPIC_MODEL: models.opus,
    ANTHROPIC_SMALL_FAST_MODEL: models.haiku,
    ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
  };
}

function getStoredPaths(hostname: string): string[] {
  try {
    const raw = localStorage.getItem(`ftown:paths:${hostname}`);
    return raw ? JSON.parse(raw) as string[] : [];
  } catch {
    return [];
  }
}

function storePath(hostname: string, path: string): void {
  if (!path.trim()) return;
  const existing = getStoredPaths(hostname);
  const filtered = existing.filter((p) => p !== path);
  const updated = [path, ...filtered].slice(0, 20);
  localStorage.setItem(`ftown:paths:${hostname}`, JSON.stringify(updated));
}

type TopShell = "claude" | "cursor" | "codex" | "opencode" | "shell";
type ClaudeFlavor = "standard" | "zai" | "kimi" | "deepseek" | "fireworks";

function shellTypeToTop(s: ShellType | undefined): { top: TopShell; flavor: ClaudeFlavor } {
  if (s === "cursor") return { top: "cursor", flavor: "standard" };
  if (s === "codex") return { top: "codex", flavor: "standard" };
  if (s === "opencode") return { top: "opencode", flavor: "standard" };
  if (s === "shell") return { top: "shell", flavor: "standard" };
  if (s === "zai") return { top: "claude", flavor: "zai" };
  if (s === "kimi") return { top: "claude", flavor: "kimi" };
  if (s === "deepseek") return { top: "claude", flavor: "deepseek" };
  if (s === "fireworks") return { top: "claude", flavor: "fireworks" };
  return { top: "claude", flavor: "standard" };
}

function resolveShellType(top: TopShell, flavor: ClaudeFlavor): ShellType {
  if (top === "cursor" || top === "codex" || top === "opencode" || top === "shell") return top;
  if (flavor === "standard") return "claude";
  return flavor;
}

function ProviderTokenHint({ provider, envVar, flavor }: { provider: string; envVar: string; flavor: string }) {
  return (
    <div className="px-3 py-2.5 border border-[#2a2a2a] rounded bg-[#0a0a0a]">
      <div className="text-xs text-[#888888]">
        Register your {provider} token on the bridge machine — the bridge maps it onto the session&apos;s auth var:
      </div>
      <code className="block mt-1.5 text-xs text-[#00ff88] font-mono break-all">
        ftown env set {flavor} &lt;token&gt;
      </code>
      <div className="text-[11px] text-[#555] mt-1.5">
        Or export <span className="font-mono">{envVar}</span> where the bridge launches (e.g. <span className="font-mono">~/.zshrc</span>). Tokens never pass through the UI.
      </div>
    </div>
  );
}

export function NewSessionModal({ isOpen, onClose, onSubmit, bridges, defaults, bridgeExec }: NewSessionModalProps) {
  const [name, setName] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [topShell, setTopShell] = useState<TopShell>("claude");
  const [claudeFlavor, setClaudeFlavor] = useState<ClaudeFlavor>("standard");
  const shellType: ShellType = resolveShellType(topShell, claudeFlavor);
  const [bridgeId, setBridgeId] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedClaudeSessionId, setSelectedClaudeSessionId] = useState<string | null>(null);
  const [selectedClaudeSummary, setSelectedClaudeSummary] = useState<string | null>(null);
  const [selectedCursorSessionId, setSelectedCursorSessionId] = useState<string | null>(null);
  const [selectedCursorSummary, setSelectedCursorSummary] = useState<string | null>(null);
  const [fireworksModels, setFireworksModels] = useState<FireworksModels>(FIREWORKS_DEFAULT_MODELS);
  const [zaiModels, setZaiModels] = useState<ZaiModels>(ZAI_DEFAULT_MODELS);
  const [autoCompactWindow, setAutoCompactWindow] = useState("");
  const [orchestrator, setOrchestrator] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const effectiveBridgeId = bridgeId || (bridges.length > 0 ? bridges[0].bridgeId : "");
  const selectedBridge = bridges.find((b) => b.bridgeId === effectiveBridgeId);
  const hostname = selectedBridge?.hostname ?? "";

  const suggestedPaths = useMemo(() => {
    if (!hostname) return [];
    const paths = getStoredPaths(hostname);
    if (!workingDir.trim()) return paths;
    return paths.filter((p) => p.toLowerCase().includes(workingDir.toLowerCase()));
  }, [hostname, workingDir]);

  useEffect(() => {
    if (isOpen && defaults) {
      setName(defaults.name ?? "");
      setWorkingDir(defaults.workingDir ?? "");
      const { top, flavor } = shellTypeToTop(defaults.shellType ?? "claude");
      setTopShell(top);
      setClaudeFlavor(flavor);
      setBridgeId(defaults.bridgeId ?? "");
      setSelectedClaudeSessionId(null);
      setSelectedClaudeSummary(null);
      setSelectedCursorSessionId(null);
      setSelectedCursorSummary(null);
      setFireworksModels(getStoredFireworksModels());
      setZaiModels(getStoredZaiModels());
      setAutoCompactWindow(getStoredAutoCompactWindow());
      setOrchestrator(false);
      setSubmitError(null);
    }
  }, [isOpen, defaults]);

  // A submit failure (e.g. missing provider auth) is tied to the chosen shell
  // type; switching shells invalidates the previous error so clear the banner.
  useEffect(() => {
    setSubmitError(null);
  }, [shellType]);

  const handleSubmit = useCallback(async () => {
    setSubmitError(null);
    if (hostname && workingDir.trim()) {
      storePath(hostname, workingDir.trim());
    }

    let env: Record<string, string> | undefined;

    if (shellType === "zai") {
      setStoredZaiModels(zaiModels);
      env = { ...getStoredEnvVars(), ...getZaiDefaultEnv(zaiModels) };
    } else if (shellType === "kimi") {
      env = { ...getStoredEnvVars(), ...getKimiDefaultEnv() };
    } else if (shellType === "deepseek") {
      env = { ...getStoredEnvVars(), ...getDeepseekDefaultEnv() };
    } else if (shellType === "fireworks") {
      setStoredFireworksModels(fireworksModels);
      env = { ...getStoredEnvVars(), ...getFireworksDefaultEnv(fireworksModels) };
    } else {
      const storedEnv = getStoredEnvVars();
      env = Object.keys(storedEnv).length > 0 ? storedEnv : undefined;
    }

    if (topShell === "claude") {
      const trimmedAutoCompact = autoCompactWindow.trim();
      setStoredAutoCompactWindow(trimmedAutoCompact);
      const effectiveAutoCompact =
        trimmedAutoCompact || FLAVOR_AUTO_COMPACT_DEFAULTS[claudeFlavor];
      if (effectiveAutoCompact) {
        env = { ...(env ?? {}), CLAUDE_CODE_AUTO_COMPACT_WINDOW: effectiveAutoCompact };
      }
    }

    try {
      await onSubmit("", {
        name: name.trim() || undefined,
        workingDir: workingDir.trim() || undefined,
        bridgeId: effectiveBridgeId || undefined,
        shellType,
        claudeSessionId: selectedClaudeSessionId ?? undefined,
        cursorSessionId: selectedCursorSessionId ?? undefined,
        env,
        orchestrator: shellType !== "shell" && orchestrator ? true : undefined,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      return;
    }

    setName("");
    setWorkingDir("");
    setTopShell("claude");
    setClaudeFlavor("standard");
    setBridgeId("");
    setShowSuggestions(false);
    setSelectedClaudeSessionId(null);
    setSelectedClaudeSummary(null);
    setSelectedCursorSessionId(null);
    setSelectedCursorSummary(null);
    setOrchestrator(false);
    onClose();
  }, [shellType, topShell, claudeFlavor, name, workingDir, effectiveBridgeId, hostname, selectedClaudeSessionId, selectedCursorSessionId, fireworksModels, zaiModels, autoCompactWindow, orchestrator, onSubmit, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      if (e.key === "Enter" && e.metaKey) {
        void handleSubmit();
      }
    },
    [onClose, handleSubmit]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full max-w-lg lg:max-w-2xl border border-[#2a2a2a] bg-[#111111] rounded-lg p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-[#00ff88] mb-4">New Session</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-[#888888] mb-1">Shell Type</label>
            <select
              value={shellType}
              onChange={(e) => {
                const { top, flavor } = shellTypeToTop(e.target.value as ShellType);
                setTopShell(top);
                setClaudeFlavor(flavor);
              }}
              className="w-full px-3 py-2 text-sm font-mono rounded"
              style={{
                background: "#0a0a0a",
                color: "#e0e0e0",
                border: "1px solid #2a2a2a",
                outline: "none",
              }}
            >
              <optgroup label="Claude Code">
                <option value="claude">Claude Code</option>
                <option value="zai">Claude Code · z.ai</option>
                <option value="kimi">Claude Code · Kimi</option>
                <option value="deepseek">Claude Code · DeepSeek</option>
                <option value="fireworks">Claude Code · Fireworks</option>
              </optgroup>
              <optgroup label="Other agents">
                <option value="cursor">Cursor Agent</option>
                <option value="codex">Codex</option>
                <option value="opencode">opencode</option>
              </optgroup>
              <optgroup label="Plain">
                <option value="shell">Shell (zsh)</option>
              </optgroup>
            </select>

            {shellType === "zai" && (
              <div className="mt-3 space-y-2">
                <ProviderTokenHint provider="z.ai" envVar="ZAI_API_TOKEN" flavor="zai" />
                {(["opus", "sonnet", "haiku"] as const).map((slot) => (
                  <div key={slot}>
                    <label className="block text-xs text-[#666] mb-1 uppercase tracking-wider">
                      {slot} model
                    </label>
                    <input
                      type="text"
                      value={zaiModels[slot]}
                      onChange={(e) =>
                        setZaiModels((prev) => ({ ...prev, [slot]: e.target.value }))
                      }
                      list="zai-model-options"
                      placeholder={`default: ${ZAI_DEFAULT_MODELS[slot]}`}
                      className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-xs text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                    />
                  </div>
                ))}
                <datalist id="zai-model-options">
                  {ZAI_MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
            )}

            {shellType === "kimi" && (
              <ProviderTokenHint provider="Kimi" envVar="KIMI_API_TOKEN" flavor="kimi" />
            )}

            {shellType === "deepseek" && (
              <ProviderTokenHint provider="DeepSeek" envVar="DEEPSEEK_API_TOKEN" flavor="deepseek" />
            )}

            {shellType === "fireworks" && (
              <div className="mt-3 space-y-2">
                <ProviderTokenHint provider="Fireworks" envVar="FIREWORKS_API_TOKEN" flavor="fireworks" />
                {(["opus", "sonnet", "haiku"] as const).map((slot) => (
                  <div key={slot}>
                    <label className="block text-xs text-[#666] mb-1 uppercase tracking-wider">
                      {slot} model
                    </label>
                    <select
                      value={fireworksModels[slot]}
                      onChange={(e) =>
                        setFireworksModels((prev) => ({ ...prev, [slot]: e.target.value }))
                      }
                      className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-xs text-[#e0e0e0] focus:outline-none focus:border-[#00ff88] font-mono"
                    >
                      {FIREWORKS_MODEL_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {m.replace("accounts/fireworks/models/", "")}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}

            {topShell === "claude" && (
              <div className="mt-3">
                <label className="block text-sm text-[#888888] mb-1">
                  Auto-Compact Window{" "}
                  <span className="text-xs text-[#555] font-mono normal-case tracking-normal">
                    (CLAUDE_CODE_AUTO_COMPACT_WINDOW)
                  </span>
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={autoCompactWindow}
                  onChange={(e) => setAutoCompactWindow(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder={
                    FLAVOR_AUTO_COMPACT_DEFAULTS[claudeFlavor]
                      ? `default: ${FLAVOR_AUTO_COMPACT_DEFAULTS[claudeFlavor]}`
                      : "tokens (leave blank to disable)"
                  }
                  className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                  onKeyDown={handleKeyDown}
                />
              </div>
            )}
          </div>

          {shellType !== "shell" && (
            <div>
              <label className="flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={orchestrator}
                  onChange={(e) => setOrchestrator(e.target.checked)}
                  className="mt-0.5 accent-[#00ff88]"
                />
                <span>
                  <span className="block text-sm text-[#888888]">Orchestrator</span>
                  <span className="block text-xs text-[#555]">
                    Brief this agent on spawning and driving worker sessions
                  </span>
                </span>
              </label>
            </div>
          )}

          <div>
            <label className="block text-sm text-[#888888] mb-1">Bridge</label>
            <select
              value={effectiveBridgeId}
              onChange={(e) => setBridgeId(e.target.value)}
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] focus:outline-none focus:border-[#00ff88]"
            >
              {bridges.map((b) => (
                <option key={b.bridgeId} value={b.bridgeId}>
                  {b.bridgeId} ({b.hostname})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-[#888888] mb-1">Session Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional name for this session"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88]"
              onKeyDown={handleKeyDown}
            />
          </div>

          <div className="relative">
            <label className="block text-sm text-[#888888] mb-1">Working Directory</label>
            <input
              type="text"
              value={workingDir}
              onChange={(e) => {
                setWorkingDir(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="/path/to/project (optional)"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88]"
              onKeyDown={handleKeyDown}
            />
            {showSuggestions && suggestedPaths.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded max-h-40 overflow-y-auto">
                {suggestedPaths.map((path) => (
                  <button
                    key={path}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setWorkingDir(path);
                      setShowSuggestions(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-[#aaa] hover:bg-[#2a2a2a] hover:text-[#e0e0e0] font-mono truncate"
                  >
                    {path}
                  </button>
                ))}
              </div>
            )}
          </div>

          {topShell === "cursor" && effectiveBridgeId && workingDir.trim() && (
            selectedCursorSessionId ? (
              <div className="flex items-center gap-2 px-3 py-2 border border-[#00ff88]/30 rounded bg-[#00ff88]/5">
                <span className="text-xs text-[#00ff88] flex-1 truncate font-mono">
                  Resuming: {selectedCursorSummary || selectedCursorSessionId.slice(0, 20)}
                </span>
                <button
                  type="button"
                  onClick={() => { setSelectedCursorSessionId(null); setSelectedCursorSummary(null); }}
                  className="text-xs text-[#666] hover:text-[#aaa] transition-colors shrink-0"
                >
                  Clear
                </button>
              </div>
            ) : (
              <CursorSessionPicker
                bridgeId={effectiveBridgeId}
                workingDir={workingDir.trim()}
                onSelect={(sid, summary) => {
                  setSelectedCursorSessionId(sid);
                  setSelectedCursorSummary(summary);
                }}
                bridgeExec={bridgeExec}
              />
            )
          )}

          {(shellType === "claude" || shellType === "zai") && effectiveBridgeId && workingDir.trim() && (
            selectedClaudeSessionId ? (
              <div className="flex items-center gap-2 px-3 py-2 border border-[#00ff88]/30 rounded bg-[#00ff88]/5">
                <span className="text-xs text-[#00ff88] flex-1 truncate font-mono">
                  Resuming: {selectedClaudeSummary || selectedClaudeSessionId.slice(0, 20)}
                </span>
                <button
                  type="button"
                  onClick={() => { setSelectedClaudeSessionId(null); setSelectedClaudeSummary(null); }}
                  className="text-xs text-[#666] hover:text-[#aaa] transition-colors shrink-0"
                >
                  Clear
                </button>
              </div>
            ) : (
              <ClaudeSessionPicker
                bridgeId={effectiveBridgeId}
                workingDir={workingDir.trim()}
                onSelect={(sid, summary) => {
                  setSelectedClaudeSessionId(sid);
                  setSelectedClaudeSummary(summary);
                }}
                bridgeExec={bridgeExec}
              />
            )
          )}

          <EnvVarsEditor />

          {submitError && (
            <div className="px-3 py-2.5 border border-[#ff5555]/40 rounded bg-[#ff5555]/10 text-xs text-[#ff8888] break-words">
              {submitError}
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-[#2a2a2a] rounded text-sm text-[#888888] hover:text-[#e0e0e0] hover:border-[#444] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              className="px-4 py-2 bg-[#00ff88] text-[#0a0a0a] font-bold rounded text-sm hover:bg-[#00cc6e] transition-colors"
            >
              Create Session
            </button>
          </div>

          <p className="text-xs text-[#444] text-right">Cmd+Enter to submit</p>
        </div>
      </div>
    </div>
  );
}
