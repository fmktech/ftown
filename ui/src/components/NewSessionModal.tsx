"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { ShellType } from "@/types";
import { BridgeInfo } from "@/hooks/useBridges";
import { BridgeExecResponse, CreateSessionBridgeError, CreateSessionOptions } from "@/hooks/useSessions";
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
  onSubmit: (prompt: string, options: CreateSessionOptions) => void | Promise<void>;
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

const GROK_MODEL_OPTIONS = [
  "grok-4.5",
  "grok-composer-2.5-fast",
] as const;

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

const LAST_SESSION_DEFAULTS_KEY = "ftown:lastSessionDefaults";

const VALID_SHELL_TYPES: ShellType[] = [
  "claude",
  "zai",
  "kimi",
  "deepseek",
  "fireworks",
  "cursor",
  "codex",
  "grok",
  "opencode",
  "shell",
];

interface LastSessionDefaults {
  bridgeId?: string;
  shellType?: string;
  workingDir?: string;
  model?: string;
}

type TopShell = "claude" | "cursor" | "codex" | "grok" | "opencode" | "shell";
type ClaudeFlavor = "standard" | "zai" | "kimi" | "deepseek" | "fireworks";

function shellTypeToTop(s: ShellType | undefined): { top: TopShell; flavor: ClaudeFlavor } {
  if (s === "cursor") return { top: "cursor", flavor: "standard" };
  if (s === "codex") return { top: "codex", flavor: "standard" };
  if (s === "grok") return { top: "grok", flavor: "standard" };
  if (s === "opencode") return { top: "opencode", flavor: "standard" };
  if (s === "shell") return { top: "shell", flavor: "standard" };
  if (s === "zai") return { top: "claude", flavor: "zai" };
  if (s === "kimi") return { top: "claude", flavor: "kimi" };
  if (s === "deepseek") return { top: "claude", flavor: "deepseek" };
  if (s === "fireworks") return { top: "claude", flavor: "fireworks" };
  return { top: "claude", flavor: "standard" };
}

function resolveShellType(top: TopShell, flavor: ClaudeFlavor): ShellType {
  if (top === "cursor" || top === "codex" || top === "grok" || top === "opencode" || top === "shell") return top;
  if (flavor === "standard") return "claude";
  return flavor;
}

// Canonical input recipe (see design brief §3 Inputs)
const INPUT_CLASS =
  "w-full px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-base)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] outline-none focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--focus-ring)] font-mono";

function ProviderTokenHint({ provider, envVar, flavor }: { provider: string; envVar: string; flavor: string }) {
  const [copied, setCopied] = useState(false);
  const command = `ftown env set ${flavor} <token>`;

  const handleCopy = () => {
    try {
      void navigator.clipboard?.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  return (
    <div className="px-3 py-2.5 border border-[var(--border-default)] rounded-[var(--radius-sm)] bg-[var(--bg-base)]">
      <div className="text-xs text-[var(--text-muted)]">
        Register your {provider} token on the bridge machine — the bridge maps it onto the session&apos;s auth var:
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <code className="flex-1 text-xs text-[var(--accent)] font-mono break-all">
          ftown env set {flavor} &lt;token&gt;
        </code>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy command to clipboard"
          className="btn-ghost !px-1.5 !py-1 shrink-0"
        >
          {copied ? "✓" : "⧉"}
        </button>
      </div>
      <div className="text-[11px] text-[var(--text-faint)] mt-1.5">
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
  const [grokModel, setGrokModel] = useState<string>(GROK_MODEL_OPTIONS[0]);
  const [autoCompactWindow, setAutoCompactWindow] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [missingWorkingDir, setMissingWorkingDir] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);

  // Move focus into the modal when it opens (a11y: focus-in).
  useEffect(() => {
    if (isOpen) {
      const id = window.setTimeout(() => firstFieldRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [isOpen]);

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
      setGrokModel(GROK_MODEL_OPTIONS[0]);
      setAutoCompactWindow(getStoredAutoCompactWindow());
      setSubmitError(null);
      setMissingWorkingDir(null);
    }
  }, [isOpen, defaults]);

  // Fill in any fields not already set by the `defaults` prop from the last
  // successfully created session. `defaults` (e.g. clone-session) always wins.
  useEffect(() => {
    if (!isOpen) return;
    try {
      const raw = localStorage.getItem(LAST_SESSION_DEFAULTS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as LastSessionDefaults;

      if (
        defaults?.bridgeId === undefined
        && typeof parsed.bridgeId === "string"
        && bridges.some((b) => b.bridgeId === parsed.bridgeId)
      ) {
        setBridgeId(parsed.bridgeId);
      }

      const restoredShellType: ShellType | undefined =
        defaults?.shellType
        ?? (typeof parsed.shellType === "string" && VALID_SHELL_TYPES.includes(parsed.shellType as ShellType)
          ? (parsed.shellType as ShellType)
          : undefined);

      if (defaults?.shellType === undefined && restoredShellType) {
        const { top, flavor } = shellTypeToTop(restoredShellType);
        setTopShell(top);
        setClaudeFlavor(flavor);
      }

      if (restoredShellType === "grok" && typeof parsed.model === "string") {
        setGrokModel(parsed.model);
      }

      if (defaults?.workingDir === undefined && typeof parsed.workingDir === "string") {
        setWorkingDir(parsed.workingDir);
      }
    } catch {
      // localStorage unavailable or malformed — ignore, form keeps its defaults
    }
  }, [isOpen, defaults, bridges]);

  // A submit failure (e.g. missing provider auth) is tied to the chosen shell
  // type; switching shells invalidates the previous error so clear the banner.
  useEffect(() => {
    setSubmitError(null);
    setMissingWorkingDir(null);
  }, [shellType]);

  const handleSubmit = useCallback(async (createMissingWorkingDir = false) => {
    setSubmitError(null);
    setMissingWorkingDir(null);
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
        model: shellType === "grok" ? grokModel : undefined,
        workingDir: workingDir.trim() || undefined,
        bridgeId: effectiveBridgeId || undefined,
        shellType,
        claudeSessionId: selectedClaudeSessionId ?? undefined,
        cursorSessionId: selectedCursorSessionId ?? undefined,
        env,
        createMissingWorkingDir: createMissingWorkingDir || undefined,
      });
    } catch (err) {
      if (
        err instanceof CreateSessionBridgeError
        && err.code === "working_dir_missing"
        && err.workingDir
        && err.canCreate
      ) {
        setMissingWorkingDir(err.workingDir);
        return;
      }
      setSubmitError(err instanceof Error ? err.message : String(err));
      return;
    }

    try {
      const lastDefaults: LastSessionDefaults = {
        bridgeId: effectiveBridgeId || undefined,
        shellType,
        workingDir: workingDir.trim() || undefined,
      };
      if (shellType === "grok") {
        lastDefaults.model = grokModel;
      }
      localStorage.setItem(LAST_SESSION_DEFAULTS_KEY, JSON.stringify(lastDefaults));
    } catch {
      // localStorage unavailable (private browsing, quota) — ignore
    }

    setName("");
    setWorkingDir("");
    setTopShell("claude");
    setClaudeFlavor("standard");
    setGrokModel(GROK_MODEL_OPTIONS[0]);
    setBridgeId("");
    setShowSuggestions(false);
    setSelectedClaudeSessionId(null);
    setSelectedClaudeSummary(null);
    setSelectedCursorSessionId(null);
    setSelectedCursorSummary(null);
    onClose();
  }, [shellType, topShell, claudeFlavor, name, workingDir, effectiveBridgeId, hostname, selectedClaudeSessionId, selectedCursorSessionId, fireworksModels, zaiModels, grokModel, autoCompactWindow, onSubmit, onClose]);

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        className="w-full max-w-lg lg:max-w-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] rounded-[var(--radius-md)] shadow-[var(--shadow-md)] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="new-session-title"
          className="sticky top-0 z-10 bg-[var(--bg-surface)] px-5 py-4 border-b border-[var(--border-muted)] text-lg font-bold text-[var(--accent)]"
        >
          New Session
        </h2>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label htmlFor="ns-shell-type" className="block text-sm text-[var(--text-muted)] mb-1">Shell Type</label>
            <select
              id="ns-shell-type"
              ref={firstFieldRef}
              value={shellType}
              onChange={(e) => {
                const { top, flavor } = shellTypeToTop(e.target.value as ShellType);
                setTopShell(top);
                setClaudeFlavor(flavor);
              }}
              className={INPUT_CLASS + " text-sm"}
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
                <option value="grok">Grok</option>
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
                    <label htmlFor={`ns-zai-${slot}`} className="block text-xs text-[var(--text-faint)] mb-1 uppercase tracking-wider">
                      {slot} model
                    </label>
                    <input
                      id={`ns-zai-${slot}`}
                      type="text"
                      value={zaiModels[slot]}
                      onChange={(e) =>
                        setZaiModels((prev) => ({ ...prev, [slot]: e.target.value }))
                      }
                      list="zai-model-options"
                      placeholder={`default: ${ZAI_DEFAULT_MODELS[slot]}`}
                      className={INPUT_CLASS + " text-xs"}
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
                    <label htmlFor={`ns-fw-${slot}`} className="block text-xs text-[var(--text-faint)] mb-1 uppercase tracking-wider">
                      {slot} model
                    </label>
                    <select
                      id={`ns-fw-${slot}`}
                      value={fireworksModels[slot]}
                      onChange={(e) =>
                        setFireworksModels((prev) => ({ ...prev, [slot]: e.target.value }))
                      }
                      className={INPUT_CLASS + " text-xs"}
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

            {shellType === "grok" && (
              <div className="mt-3">
                <label htmlFor="ns-grok-model" className="block text-sm text-[var(--text-muted)] mb-1">
                  Model
                </label>
                <select
                  id="ns-grok-model"
                  value={grokModel}
                  onChange={(e) => setGrokModel(e.target.value)}
                  className={INPUT_CLASS + " text-sm"}
                >
                  {GROK_MODEL_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {topShell === "claude" && (
              <div className="mt-3">
                <label htmlFor="ns-auto-compact" className="block text-sm text-[var(--text-muted)] mb-1">
                  Auto-Compact Window{" "}
                  <span className="text-xs text-[var(--text-faint)] font-mono normal-case tracking-normal">
                    (CLAUDE_CODE_AUTO_COMPACT_WINDOW)
                  </span>
                </label>
                <input
                  id="ns-auto-compact"
                  type="text"
                  inputMode="numeric"
                  value={autoCompactWindow}
                  onChange={(e) => setAutoCompactWindow(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder={
                    FLAVOR_AUTO_COMPACT_DEFAULTS[claudeFlavor]
                      ? `default: ${FLAVOR_AUTO_COMPACT_DEFAULTS[claudeFlavor]}`
                      : "tokens (leave blank to disable)"
                  }
                  className={INPUT_CLASS + " text-sm"}
                  onKeyDown={handleKeyDown}
                />
              </div>
            )}
          </div>

          {shellType !== "shell" && (
            <div className="rounded-[var(--radius-sm)] border border-[var(--border-muted)] px-3 py-2">
                <span className="block text-sm text-[var(--text-muted)]">Need an orchestrator?</span>
                <span className="block text-xs text-[var(--text-faint)]">
                  Start a normal session and ask it to use the{" "}
                <span className="text-[var(--accent)]">ftown</span> skill&apos;s orchestrator
                reference to spawn and coordinate worker sessions.
                </span>
              </div>
            )}

          <div>
            <label htmlFor="ns-bridge" className="block text-sm text-[var(--text-muted)] mb-1">Bridge</label>
            {bridges.length === 0 ? (
              <div
                role="alert"
                className="px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--status-pending)] bg-[rgba(255,170,0,0.08)] text-xs text-[var(--status-pending)] flex items-start gap-2"
              >
                <span aria-hidden>⚠</span>
                <span>No bridges connected — start ftown-bridge on a machine first.</span>
              </div>
            ) : (
              <select
                id="ns-bridge"
                value={effectiveBridgeId}
                onChange={(e) => setBridgeId(e.target.value)}
                className={INPUT_CLASS + " text-sm"}
              >
                {bridges.map((b) => (
                  <option key={b.bridgeId} value={b.bridgeId}>
                    {b.bridgeId} ({b.hostname})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label htmlFor="ns-name" className="block text-sm text-[var(--text-muted)] mb-1">
              Session Name{" "}
              <span className="text-xs text-[var(--text-faint)] normal-case">(optional)</span>
            </label>
            <input
              id="ns-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional name for this session"
              className={INPUT_CLASS + " text-sm"}
              onKeyDown={handleKeyDown}
            />
          </div>

          <div className="relative">
            <label htmlFor="ns-working-dir" className="block text-sm text-[var(--text-muted)] mb-1">
              Working Directory{" "}
              <span className="text-xs text-[var(--text-faint)] normal-case">(optional)</span>
            </label>
            <input
              id="ns-working-dir"
              type="text"
              role="combobox"
              aria-expanded={showSuggestions && suggestedPaths.length > 0}
              aria-controls="ns-path-suggestions"
              aria-autocomplete="list"
              value={workingDir}
              onChange={(e) => {
                setWorkingDir(e.target.value);
                setMissingWorkingDir(null);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="/path/to/project (optional)"
              className={INPUT_CLASS + " text-sm"}
              onKeyDown={handleKeyDown}
            />
            {showSuggestions && suggestedPaths.length > 0 && (
              <div
                id="ns-path-suggestions"
                role="listbox"
                aria-label="Recent working directories"
                className="absolute z-10 w-full mt-1 bg-[var(--bg-overlay)] border border-[var(--border-default)] rounded-[var(--radius-sm)] max-h-40 overflow-y-auto shadow-[var(--shadow-md)]"
              >
                {suggestedPaths.map((path) => (
                  <button
                    key={path}
                    type="button"
                    role="option"
                    aria-selected={workingDir === path}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setWorkingDir(path);
                      setShowSuggestions(false);
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--bg-hover)] font-mono truncate"
                  >
                    {path}
                  </button>
                ))}
              </div>
            )}
          </div>

          {topShell === "cursor" && effectiveBridgeId && workingDir.trim() && (
            selectedCursorSessionId ? (
              <div className="flex items-center gap-2 px-3 py-2 border border-[var(--accent)]/30 rounded-[var(--radius-sm)] bg-[var(--accent-dim)]">
                <span className="text-xs text-[var(--accent)] flex-1 truncate font-mono">
                  Resuming: {selectedCursorSummary || selectedCursorSessionId.slice(0, 20)}
                </span>
                <button
                  type="button"
                  onClick={() => { setSelectedCursorSessionId(null); setSelectedCursorSummary(null); }}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
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
              <div className="flex items-center gap-2 px-3 py-2 border border-[var(--accent)]/30 rounded-[var(--radius-sm)] bg-[var(--accent-dim)]">
                <span className="text-xs text-[var(--accent)] flex-1 truncate font-mono">
                  Resuming: {selectedClaudeSummary || selectedClaudeSessionId.slice(0, 20)}
                </span>
                <button
                  type="button"
                  onClick={() => { setSelectedClaudeSessionId(null); setSelectedClaudeSummary(null); }}
                  className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
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

          {missingWorkingDir && (
            <div
              role="alert"
              aria-live="assertive"
              className="fade-in px-3 py-2.5 border-l-2 border border-[var(--status-pending)] rounded-[var(--radius-sm)] bg-[rgba(255,170,0,0.1)] text-xs text-[var(--status-pending)] space-y-2"
            >
              <div className="flex items-start gap-2">
                <span aria-hidden>⚠</span>
                <span>Working directory does not exist.</span>
              </div>
              <code className="block font-mono break-all text-[var(--status-pending)]">{missingWorkingDir}</code>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setMissingWorkingDir(null)}
                  className="btn-ghost"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmit(true)}
                  className="btn-warn"
                >
                  Create Folder
                </button>
              </div>
            </div>
          )}

          {submitError && (
            <div
              role="alert"
              aria-live="assertive"
              className="fade-in flex items-start gap-2 px-3 py-2.5 border-l-2 border border-[var(--status-error)] rounded-[var(--radius-sm)] bg-[rgba(255,68,102,0.08)] text-xs text-[var(--status-error)] break-words"
            >
              <span aria-hidden>⚠</span>
              <span>{submitError}</span>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 z-10 bg-[var(--bg-surface)] px-5 py-4 border-t border-[var(--border-muted)] flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--text-faint)]">Cmd+Enter to submit</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              className="btn-accent"
            >
              Create Session
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
