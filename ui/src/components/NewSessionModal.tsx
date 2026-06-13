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
  onSubmit: (prompt: string, options: { name?: string; model?: string; workingDir?: string; bridgeId?: string; shellType?: ShellType; claudeSessionId?: string; cursorSessionId?: string; env?: Record<string, string>; orchestrator?: boolean }) => void;
  bridges: BridgeInfo[];
  defaults?: SessionDefaults;
  bridgeExec: (command: string, workingDir: string, bridgeId: string) => Promise<BridgeExecResponse>;
}

const ZAI_TOKEN_KEY = "ftown:zaiToken";
const KIMI_TOKEN_KEY = "ftown:kimiToken";
const DEEPSEEK_TOKEN_KEY = "ftown:deepseekToken";
const FIREWORKS_TOKEN_KEY = "ftown:fireworksToken";
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

const AUTO_COMPACT_WINDOW_KEY = "ftown:autoCompactWindow";

const FLAVOR_AUTO_COMPACT_DEFAULTS: Record<"standard" | "zai" | "kimi" | "deepseek" | "fireworks", string> = {
  standard: "",
  zai: "200000",
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

function getStoredZaiToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(ZAI_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function setStoredZaiToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ZAI_TOKEN_KEY, token);
}

function getStoredKimiToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(KIMI_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function setStoredKimiToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(KIMI_TOKEN_KEY, token);
}

function getStoredDeepseekToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(DEEPSEEK_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function setStoredDeepseekToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(DEEPSEEK_TOKEN_KEY, token);
}

function getStoredFireworksToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(FIREWORKS_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function setStoredFireworksToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(FIREWORKS_TOKEN_KEY, token);
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

function getZaiDefaultEnv(token: string): Record<string, string> {
  return {
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "GLM-4.7-Flash",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "GLM-5.1",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "GLM-5-Turbo",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
  };
}

function getKimiDefaultEnv(token: string): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "256000",
  };
}

function getDeepseekDefaultEnv(token: string): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
  };
}

function getFireworksDefaultEnv(token: string, models: FireworksModels): Record<string, string> {
  return {
    ANTHROPIC_AUTH_TOKEN: token,
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
  const [zaiToken, setZaiToken] = useState("");
  const [kimiToken, setKimiToken] = useState("");
  const [deepseekToken, setDeepseekToken] = useState("");
  const [fireworksToken, setFireworksToken] = useState("");
  const [fireworksModels, setFireworksModels] = useState<FireworksModels>(FIREWORKS_DEFAULT_MODELS);
  const [autoCompactWindow, setAutoCompactWindow] = useState("");
  const [orchestrator, setOrchestrator] = useState(false);

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
      setZaiToken(getStoredZaiToken());
      setKimiToken(getStoredKimiToken());
      setDeepseekToken(getStoredDeepseekToken());
      setFireworksToken(getStoredFireworksToken());
      setFireworksModels(getStoredFireworksModels());
      setAutoCompactWindow(getStoredAutoCompactWindow());
      setOrchestrator(false);
    }
  }, [isOpen, defaults]);

  const handleSubmit = useCallback(() => {
    if (hostname && workingDir.trim()) {
      storePath(hostname, workingDir.trim());
    }

    let env: Record<string, string> | undefined;

    if (shellType === "zai") {
      const trimmedToken = zaiToken.trim();
      if (trimmedToken) setStoredZaiToken(trimmedToken);
      env = { ...getStoredEnvVars(), ...getZaiDefaultEnv(trimmedToken) };
    } else if (shellType === "kimi") {
      const trimmedToken = kimiToken.trim();
      if (trimmedToken) setStoredKimiToken(trimmedToken);
      env = { ...getStoredEnvVars(), ...getKimiDefaultEnv(trimmedToken) };
    } else if (shellType === "deepseek") {
      const trimmedToken = deepseekToken.trim();
      if (trimmedToken) setStoredDeepseekToken(trimmedToken);
      env = { ...getStoredEnvVars(), ...getDeepseekDefaultEnv(trimmedToken) };
    } else if (shellType === "fireworks") {
      const trimmedToken = fireworksToken.trim();
      if (trimmedToken) setStoredFireworksToken(trimmedToken);
      setStoredFireworksModels(fireworksModels);
      env = { ...getStoredEnvVars(), ...getFireworksDefaultEnv(trimmedToken, fireworksModels) };
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

    onSubmit("", {
      name: name.trim() || undefined,
      workingDir: workingDir.trim() || undefined,
      bridgeId: effectiveBridgeId || undefined,
      shellType,
      claudeSessionId: selectedClaudeSessionId ?? undefined,
      cursorSessionId: selectedCursorSessionId ?? undefined,
      env,
      orchestrator: shellType !== "shell" && orchestrator ? true : undefined,
    });

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
  }, [shellType, topShell, claudeFlavor, name, workingDir, effectiveBridgeId, hostname, selectedClaudeSessionId, selectedCursorSessionId, zaiToken, kimiToken, deepseekToken, fireworksToken, fireworksModels, autoCompactWindow, orchestrator, onSubmit, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      if (e.key === "Enter" && e.metaKey) {
        handleSubmit();
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
            <div className="flex gap-0">
              <button
                type="button"
                onClick={() => setTopShell("claude")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: topShell === "claude" ? "#00ff88" : "#0a0a0a",
                  color: topShell === "claude" ? "#0a0a0a" : "#888888",
                  border: `1px solid ${topShell === "claude" ? "#00ff88" : "#2a2a2a"}`,
                  borderRight: "none",
                  borderRadius: "4px 0 0 4px",
                  fontWeight: topShell === "claude" ? 700 : 400,
                }}
              >
                Claude
              </button>
              <button
                type="button"
                onClick={() => setTopShell("cursor")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: topShell === "cursor" ? "#00ff88" : "#0a0a0a",
                  color: topShell === "cursor" ? "#0a0a0a" : "#888888",
                  border: `1px solid ${topShell === "cursor" ? "#00ff88" : "#2a2a2a"}`,
                  borderRight: "none",
                  fontWeight: topShell === "cursor" ? 700 : 400,
                }}
              >
                Cursor
              </button>
              <button
                type="button"
                onClick={() => setTopShell("codex")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: topShell === "codex" ? "#00ff88" : "#0a0a0a",
                  color: topShell === "codex" ? "#0a0a0a" : "#888888",
                  border: `1px solid ${topShell === "codex" ? "#00ff88" : "#2a2a2a"}`,
                  borderRight: "none",
                  fontWeight: topShell === "codex" ? 700 : 400,
                }}
              >
                Codex
              </button>
              <button
                type="button"
                onClick={() => setTopShell("opencode")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: topShell === "opencode" ? "#00ff88" : "#0a0a0a",
                  color: topShell === "opencode" ? "#0a0a0a" : "#888888",
                  border: `1px solid ${topShell === "opencode" ? "#00ff88" : "#2a2a2a"}`,
                  borderRight: "none",
                  fontWeight: topShell === "opencode" ? 700 : 400,
                }}
              >
                opencode
              </button>
              <button
                type="button"
                onClick={() => setTopShell("shell")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: topShell === "shell" ? "#00ff88" : "#0a0a0a",
                  color: topShell === "shell" ? "#0a0a0a" : "#888888",
                  border: `1px solid ${topShell === "shell" ? "#00ff88" : "#2a2a2a"}`,
                  borderRadius: "0 4px 4px 0",
                  fontWeight: topShell === "shell" ? 700 : 400,
                }}
              >
                Shell (zsh)
              </button>
            </div>

            {topShell === "claude" && (
              <div className="mt-3">
                <label className="block text-xs text-[#666] mb-1 uppercase tracking-wider">Flavor</label>
                <div className="flex gap-0">
                  {(["standard", "zai", "kimi", "deepseek", "fireworks"] as ClaudeFlavor[]).map((f, i, arr) => {
                    const labels: Record<ClaudeFlavor, string> = {
                      standard: "Standard",
                      zai: "z.ai",
                      kimi: "Kimi",
                      deepseek: "DeepSeek",
                      fireworks: "Fireworks",
                    };
                    const active = claudeFlavor === f;
                    const isFirst = i === 0;
                    const isLast = i === arr.length - 1;
                    return (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setClaudeFlavor(f)}
                        className="px-3 py-1.5 text-xs font-mono transition-colors"
                        style={{
                          background: active ? "#00ff88" : "#0a0a0a",
                          color: active ? "#0a0a0a" : "#888888",
                          border: `1px solid ${active ? "#00ff88" : "#2a2a2a"}`,
                          borderRight: isLast ? undefined : "none",
                          borderRadius: isFirst ? "4px 0 0 4px" : isLast ? "0 4px 4px 0" : "0",
                          fontWeight: active ? 700 : 400,
                        }}
                      >
                        {labels[f]}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {shellType === "zai" && (
              <div className="mt-3">
                <label className="block text-sm text-[#888888] mb-1">z.ai API Token</label>
                <input
                  type="password"
                  value={zaiToken}
                  onChange={(e) => setZaiToken(e.target.value)}
                  placeholder="Enter your z.ai API token"
                  className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                  onKeyDown={handleKeyDown}
                  autoComplete="new-password"
                />
              </div>
            )}

            {shellType === "kimi" && (
              <div className="mt-3">
                <label className="block text-sm text-[#888888] mb-1">Kimi API Token</label>
                <input
                  type="password"
                  value={kimiToken}
                  onChange={(e) => setKimiToken(e.target.value)}
                  placeholder="Enter your Kimi API token"
                  className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                  onKeyDown={handleKeyDown}
                  autoComplete="new-password"
                />
              </div>
            )}

            {shellType === "deepseek" && (
              <div className="mt-3">
                <label className="block text-sm text-[#888888] mb-1">DeepSeek API Token</label>
                <input
                  type="password"
                  value={deepseekToken}
                  onChange={(e) => setDeepseekToken(e.target.value)}
                  placeholder="Enter your DeepSeek API token"
                  className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                  onKeyDown={handleKeyDown}
                  autoComplete="new-password"
                />
              </div>
            )}

            {shellType === "fireworks" && (
              <div className="mt-3 space-y-2">
                <div>
                  <label className="block text-sm text-[#888888] mb-1">Fireworks API Token</label>
                  <input
                    type="password"
                    value={fireworksToken}
                    onChange={(e) => setFireworksToken(e.target.value)}
                    placeholder="Enter your Fireworks API token"
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] font-mono"
                    onKeyDown={handleKeyDown}
                    autoComplete="new-password"
                  />
                </div>
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
