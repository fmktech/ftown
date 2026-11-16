"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { ShellType, type AccountHarness, type HarnessAccountSummary, type Session } from "@/types";
import { BridgeInfo } from "@/hooks/useBridges";
import { CreateSessionBridgeError, CreateSessionOptions } from "@/hooks/useSessions";
import type { Command, CommandResponse } from "@/types";
import { ClaudeSessionPicker } from "./ClaudeSessionPicker";
import { CursorSessionPicker } from "./CursorSessionPicker";
import EnvVarsEditor, { getStoredEnvVars } from "./EnvVarsEditor";

export interface SessionDefaults {
  name?: string;
  workingDir?: string;
  bridgeId?: string;
  shellType?: ShellType;
  account?: string;
  parentSessionId?: string;
  allowedAccounts?: string[];
}

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (prompt: string, options: CreateSessionOptions) => void | Promise<void>;
  bridges: BridgeInfo[];
  defaults?: SessionDefaults;
  sendCommand: (command: Command, options?: { retryBridgeStarting?: boolean }) => Promise<CommandResponse>;
  sessions?: Session[];
}

const EMPTY_SESSIONS: Session[] = [];
const ACCOUNT_STARTING_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const ACCOUNT_ID = /^[a-z0-9-]{1,32}$/;
type AccountsView = { bridgeId: string; status: "loading" | "ready" | "error" | "unsupported"; accounts: HarnessAccountSummary[]; error?: string };

function parseAccounts(value: unknown): HarnessAccountSummary[] | null {
  if (!value || typeof value !== "object" || !("accounts" in value) || !Array.isArray(value.accounts)) return null;
  const accounts: HarnessAccountSummary[] = [];
  for (const account of value.accounts) {
    if (!account || typeof account !== "object" || typeof account.id !== "string" || !ACCOUNT_ID.test(account.id)
      || (account.harness !== "claude" && account.harness !== "codex") || (account.label !== undefined && typeof account.label !== "string")
      || typeof account.isDefault !== "boolean" || (account.id === "default") !== account.isDefault
      || accounts.some(candidate => candidate.id === account.id && (account.id !== "default" || candidate.harness === account.harness))) return null;
    accounts.push({ id: account.id, harness: account.harness, isDefault: account.isDefault, ...(account.label !== undefined ? { label: account.label } : {}) });
  }
  return (["claude", "codex"] as const).every(harness => accounts.some(account => account.harness === harness && account.isDefault)) ? accounts : null;
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

// kimi-code is a standalone CLI (its own binary), NOT the `kimi` provider-flavor.
// The default alias k3 is the CLI's own default, so its option value is empty —
// selecting it omits the -m flag entirely (matching the bridge command builder).
const KIMI_CODE_MODEL_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "", label: "k3 (default)" },
  { value: "kimi-code/kimi-for-coding", label: "kimi-for-coding" },
  { value: "kimi-code/kimi-for-coding-highspeed", label: "kimi-for-coding-highspeed" },
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
  "muse",
  "antigravity",
  "pi",
  "kimi-code",
  "opencode",
  "shell",
];

interface LastSessionDefaults {
  bridgeId?: string;
  shellType?: string;
  workingDir?: string;
  model?: string;
}

type TopShell = "claude" | "cursor" | "codex" | "grok" | "muse" | "antigravity" | "pi" | "kimi-code" | "opencode" | "shell";
type ClaudeFlavor = "standard" | "zai" | "kimi" | "deepseek" | "fireworks";

function shellTypeToTop(s: ShellType | undefined): { top: TopShell; flavor: ClaudeFlavor } {
  if (s === "cursor") return { top: "cursor", flavor: "standard" };
  if (s === "codex") return { top: "codex", flavor: "standard" };
  if (s === "grok") return { top: "grok", flavor: "standard" };
  if (s === "muse") return { top: "muse", flavor: "standard" };
  if (s === "antigravity") return { top: "antigravity", flavor: "standard" };
  if (s === "pi") return { top: "pi", flavor: "standard" };
  if (s === "kimi-code") return { top: "kimi-code", flavor: "standard" };
  if (s === "opencode") return { top: "opencode", flavor: "standard" };
  if (s === "shell") return { top: "shell", flavor: "standard" };
  if (s === "zai") return { top: "claude", flavor: "zai" };
  if (s === "kimi") return { top: "claude", flavor: "kimi" };
  if (s === "deepseek") return { top: "claude", flavor: "deepseek" };
  if (s === "fireworks") return { top: "claude", flavor: "fireworks" };
  return { top: "claude", flavor: "standard" };
}

function resolveShellType(top: TopShell, flavor: ClaudeFlavor): ShellType {
  if (top === "cursor" || top === "codex" || top === "grok" || top === "muse" || top === "antigravity" || top === "pi" || top === "kimi-code" || top === "opencode" || top === "shell") return top;
  if (flavor === "standard") return "claude";
  return flavor;
}

// Canonical input recipe (see design brief §3 Inputs)
const INPUT_CLASS =
  "w-full px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-base)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] outline-none focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--focus-ring)] font-mono";

function getSubmitModifier(): "metaKey" | "ctrlKey" {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = navigatorWithUserAgentData.userAgentData?.platform || navigator.platform;
  return /mac/i.test(platform) ? "metaKey" : "ctrlKey";
}

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

export function NewSessionModal({ isOpen, onClose, onSubmit, bridges, defaults, sendCommand, sessions = EMPTY_SESSIONS }: NewSessionModalProps) {
  const [name, setName] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [topShell, setTopShell] = useState<TopShell>("claude");
  const [claudeFlavor, setClaudeFlavor] = useState<ClaudeFlavor>("standard");
  const shellType: ShellType = resolveShellType(topShell, claudeFlavor);
  const [bridgeId, setBridgeId] = useState("");
  const [parentSessionId, setParentSessionId] = useState("");
  const [account, setAccount] = useState("default");
  const [accountChosen, setAccountChosen] = useState(false);
  const [allowedAccounts, setAllowedAccounts] = useState<string[] | undefined>();
  const [accountsView, setAccountsView] = useState<AccountsView | null>(null);
  const [accountsReload, setAccountsReload] = useState(0);
  const sendCommandRef = useRef(sendCommand);
  sendCommandRef.current = sendCommand;
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedClaudeSessionId, setSelectedClaudeSessionId] = useState<string | null>(null);
  const [selectedClaudeSummary, setSelectedClaudeSummary] = useState<string | null>(null);
  const [selectedCursorSessionId, setSelectedCursorSessionId] = useState<string | null>(null);
  const [selectedCursorSummary, setSelectedCursorSummary] = useState<string | null>(null);
  const [fireworksModels, setFireworksModels] = useState<FireworksModels>(FIREWORKS_DEFAULT_MODELS);
  const [zaiModels, setZaiModels] = useState<ZaiModels>(ZAI_DEFAULT_MODELS);
  const [grokModel, setGrokModel] = useState<string>(GROK_MODEL_OPTIONS[0]);
  const [museModel, setMuseModel] = useState("");
  const [antigravityModel, setAntigravityModel] = useState("");
  const [piModel, setPiModel] = useState("");
  const [kimiCodeModel, setKimiCodeModel] = useState<string>(KIMI_CODE_MODEL_OPTIONS[0].value);
  const [opencodeModel, setOpencodeModel] = useState("");
  const [autoCompactWindow, setAutoCompactWindow] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [missingWorkingDir, setMissingWorkingDir] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const initializedForOpenRef = useRef(false);
  const pendingRestoredBridgeIdRef = useRef<string | null>(null);
  const bridgeEditedRef = useRef(false);

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
  const parents = sessions.filter(session => session.bridgeId === effectiveBridgeId);
  const parent = parents.find(session => session.id === parentSessionId);
  const resolvedParent = parent?.parentSessionId ? parents.find(session => session.id === parent.parentSessionId) : parent;
  const directPolicy = parent?.allowedAccounts;
  const resolvedPolicy = resolvedParent?.allowedAccounts;
  const parentPolicy = directPolicy && resolvedPolicy
    ? directPolicy.filter(id => resolvedPolicy.includes(id)) : directPolicy ?? resolvedPolicy;
  const accountHarness: AccountHarness | null = shellType === "claude" || shellType === "codex" ? shellType : null;
  const currentAccounts = accountsView?.bridgeId === effectiveBridgeId ? accountsView : null;
  const accountsLoading = Boolean(effectiveBridgeId) && (!currentAccounts || currentAccounts.status === "loading");
  const registeredAccounts = currentAccounts?.status === "ready" ? currentAccounts.accounts : [];
  const choices = (currentAccounts?.status === "ready"
    ? registeredAccounts.filter(candidate => candidate.harness === accountHarness)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id))
      .map(candidate => ({ id: candidate.id, label: candidate.isDefault ? "Default account" : candidate.label ? `${candidate.label} (${candidate.id})` : candidate.id }))
    : [{ id: "default", label: "Default account" }]
  ).filter(candidate => parentPolicy === undefined || parentPolicy.includes(candidate.id));
  const preferredAccount = parent ? resolvedParent?.account ?? "default" : defaults?.account ?? "default";
  const missingPreferredAccount = accountHarness !== null && preferredAccount !== "default"
    && !accountsLoading && !registeredAccounts.some(candidate => candidate.id === preferredAccount);
  const needsReplacement = missingPreferredAccount && !accountChosen;
  const selectedAccount = needsReplacement ? "" : choices.some(candidate => candidate.id === account) ? account
    : choices.some(candidate => candidate.id === preferredAccount) ? preferredAccount : choices[0]?.id ?? "";
  const policyChoices = [
    { id: "default", label: "Default account" },
    ...registeredAccounts.filter(candidate => !candidate.isDefault).sort((a, b) => a.id.localeCompare(b.id)).map(candidate => ({ id: candidate.id, label: `${candidate.label ?? candidate.id} (${candidate.harness})` })),
  ].filter(candidate => parentPolicy === undefined || parentPolicy.includes(candidate.id));
  const incompatibleInheritance = Boolean(parent && !accountHarness && resolvedParent?.account !== undefined);
  const parentDisallowsDefault = Boolean(parent && !accountHarness && parentPolicy !== undefined && !parentPolicy.includes("default"));
  const policyUnavailable = allowedAccounts !== undefined && (currentAccounts?.status !== "ready"
    || allowedAccounts.some(id => !policyChoices.some(choice => choice.id === id)));
  const accountBlocked = incompatibleInheritance || parentDisallowsDefault || policyUnavailable
    || (accountHarness !== null && (accountsLoading || choices.length === 0 || needsReplacement));

  useEffect(() => {
    if (!isOpen || !effectiveBridgeId) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let wakeRetry: (() => void) | undefined;
    setAccountsView({ bridgeId: effectiveBridgeId, status: "loading", accounts: [] });
    const requestId = crypto.randomUUID();
    const diagnosticBridgeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(effectiveBridgeId) ? effectiveBridgeId : "unknown";
    const diagnosticContext = `bridge:${diagnosticBridgeId} request:${requestId}`;
    console.warn(`[get_accounts] ${diagnosticContext} attempt`);
    void (async () => {
      try {
        let response: CommandResponse | undefined;
        for (let attempt = 0; attempt <= ACCOUNT_STARTING_RETRY_DELAYS_MS.length; attempt++) {
          response = await sendCommandRef.current({ type: "get_accounts", payload: { bridgeId: effectiveBridgeId }, requestId }, { retryBridgeStarting: false });
          const code = response.data && typeof response.data === "object" && "code" in response.data ? response.data.code : undefined;
          if (cancelled) return;
          if (response.success || code !== "bridge_starting" || attempt === ACCOUNT_STARTING_RETRY_DELAYS_MS.length) break;
          console.warn(`[get_accounts] ${diagnosticContext} response:bridge_starting`);
          await new Promise<void>(resolve => {
            wakeRetry = resolve;
            retryTimer = setTimeout(() => { retryTimer = undefined; wakeRetry = undefined; resolve(); }, ACCOUNT_STARTING_RETRY_DELAYS_MS[attempt]);
          });
          if (cancelled) return;
        }
        if (cancelled || !response) return;
        if (!response.success) {
          const code = response.data && typeof response.data === "object" && "code" in response.data ? response.data.code : undefined;
          console.warn(`[get_accounts] ${diagnosticContext} response:${typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : "unknown"}`);
          const unsupported = response.error === "Unknown command type: get_accounts";
          const starting = code === "bridge_starting";
          setAccountsView({ bridgeId: effectiveBridgeId, status: unsupported ? "unsupported" : "error", accounts: [], error: unsupported
            ? "Update this computer's bridge to choose registered accounts."
            : starting ? "This computer is still starting. Try again shortly." : "Could not load accounts from this computer." });
          return;
        }
        const accounts = parseAccounts(response.data);
        setAccountsView(accounts === null
          ? { bridgeId: effectiveBridgeId, status: "error", accounts: [], error: "Could not read the accounts returned by this computer." }
          : { bridgeId: effectiveBridgeId, status: "ready", accounts });
      } catch (error) {
        if (!cancelled) {
          console.warn(`[get_accounts] ${diagnosticContext} send:${error instanceof Error && error.message === "get_accounts timed out" ? "timeout" : "rejected"}`);
          setAccountsView({ bridgeId: effectiveBridgeId, status: "error", accounts: [], error: "Could not load accounts from this computer." });
        }
      }
    })();
    return () => { cancelled = true; if (retryTimer !== undefined) clearTimeout(retryTimer); wakeRetry?.(); wakeRetry = undefined; };
  }, [isOpen, effectiveBridgeId, accountsReload]);

  useEffect(() => {
    setAccount(preferredAccount);
    setAccountChosen(false);
    setAllowedAccounts(defaults?.allowedAccounts);
    setSelectedClaudeSessionId(null);
    setSelectedClaudeSummary(null);
  }, [isOpen, effectiveBridgeId, shellType, parentSessionId, preferredAccount, defaults?.account, defaults?.allowedAccounts]);

  const suggestedPaths = useMemo(() => {
    if (!hostname) return [];
    const paths = getStoredPaths(hostname);
    if (!workingDir.trim()) return paths;
    return paths.filter((p) => p.toLowerCase().includes(workingDir.toLowerCase()));
  }, [hostname, workingDir]);

  // Initialize exactly once for each opening. Bridge presence can update while
  // the modal is open; rerunning this initialization on that update used to
  // replace a working directory while the user was typing it.
  useEffect(() => {
    if (!isOpen) {
      initializedForOpenRef.current = false;
      pendingRestoredBridgeIdRef.current = null;
      bridgeEditedRef.current = false;
      return;
    }
    if (initializedForOpenRef.current) return;
    initializedForOpenRef.current = true;

    let parsed: LastSessionDefaults = {};
    try {
      const raw = localStorage.getItem(LAST_SESSION_DEFAULTS_KEY);
      if (raw) {
        const candidate: unknown = JSON.parse(raw);
        if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
          parsed = candidate as LastSessionDefaults;
        }
      }
    } catch {
      // localStorage unavailable or malformed — initialize from explicit defaults.
    }

    const restoredShellType: ShellType =
      defaults?.shellType
      ?? (typeof parsed.shellType === "string" && VALID_SHELL_TYPES.includes(parsed.shellType as ShellType)
        ? (parsed.shellType as ShellType)
        : "claude");
    const { top, flavor } = shellTypeToTop(restoredShellType);
    const desiredBridgeId = defaults?.bridgeId
      ?? (typeof parsed.bridgeId === "string" ? parsed.bridgeId : "");
    const restoredBridgeId = bridges.some((b) => b.bridgeId === desiredBridgeId)
      ? desiredBridgeId
      : "";
    pendingRestoredBridgeIdRef.current = desiredBridgeId && !restoredBridgeId
      ? desiredBridgeId
      : null;
    const restoredWorkingDir = defaults?.workingDir
      ?? (typeof parsed.workingDir === "string" ? parsed.workingDir : "");

    setName(defaults?.name ?? "");
    setWorkingDir(restoredWorkingDir);
    setTopShell(top);
    setClaudeFlavor(flavor);
    setBridgeId(restoredBridgeId);
    setParentSessionId(defaults?.parentSessionId ?? "");
    setAccount(defaults?.account ?? "default");
    setAllowedAccounts(defaults?.allowedAccounts);
    setSelectedClaudeSessionId(null);
    setSelectedClaudeSummary(null);
    setSelectedCursorSessionId(null);
    setSelectedCursorSummary(null);
    setFireworksModels(getStoredFireworksModels());
    setZaiModels(getStoredZaiModels());
    setGrokModel(restoredShellType === "grok" && typeof parsed.model === "string" ? parsed.model : GROK_MODEL_OPTIONS[0]);
    setMuseModel(restoredShellType === "muse" && typeof parsed.model === "string" ? parsed.model : "");
    setAntigravityModel(restoredShellType === "antigravity" && typeof parsed.model === "string" ? parsed.model : "");
    setPiModel(restoredShellType === "pi" && typeof parsed.model === "string" ? parsed.model : "");
    setKimiCodeModel(restoredShellType === "kimi-code" && typeof parsed.model === "string" ? parsed.model : KIMI_CODE_MODEL_OPTIONS[0].value);
    setOpencodeModel(restoredShellType === "opencode" && typeof parsed.model === "string" ? parsed.model : "");
    setAutoCompactWindow(getStoredAutoCompactWindow());
    setSubmitError(null);
    setMissingWorkingDir(null);
  }, [isOpen, defaults, bridges]);

  // Bridge discovery is asynchronous. Restore a saved bridge when it arrives,
  // but never replace a bridge the user selected while the modal was open.
  useEffect(() => {
    if (!isOpen || bridgeEditedRef.current) return;
    const pendingBridgeId = pendingRestoredBridgeIdRef.current;
    if (!pendingBridgeId || !bridges.some((bridge) => bridge.bridgeId === pendingBridgeId)) return;
    setBridgeId(pendingBridgeId);
    pendingRestoredBridgeIdRef.current = null;
  }, [isOpen, bridges]);

  // A submit failure (e.g. missing provider auth) is tied to the chosen shell
  // type; switching shells invalidates the previous error so clear the banner.
  useEffect(() => {
    setSubmitError(null);
    setMissingWorkingDir(null);
  }, [shellType]);

  const handleSubmit = useCallback(async (createMissingWorkingDir = false) => {
    setSubmitError(null);
    setMissingWorkingDir(null);
    if (accountBlocked) {
      setSubmitError(accountsLoading ? "Wait for accounts to finish loading." : "This parent does not allow an account for the selected shell.");
      return;
    }
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
        model: shellType === "grok" ? grokModel : shellType === "muse" ? museModel.trim() || undefined : shellType === "antigravity" ? antigravityModel.trim() || undefined : shellType === "pi" ? piModel.trim() || undefined : shellType === "kimi-code" ? kimiCodeModel : shellType === "opencode" ? opencodeModel.trim() || undefined : undefined,
        workingDir: workingDir.trim() || undefined,
        bridgeId: effectiveBridgeId || undefined,
        shellType,
        ...(accountHarness ? { account: selectedAccount } : {}),
        ...(parent ? { parentSessionId: parent.id } : {}),
        ...(allowedAccounts !== undefined ? { allowedAccounts } : {}),
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
      if (shellType === "muse") {
        lastDefaults.model = museModel.trim() || undefined;
      }
      if (shellType === "antigravity") {
        lastDefaults.model = antigravityModel.trim() || undefined;
      }
      if (shellType === "pi") {
        lastDefaults.model = piModel.trim() || undefined;
      }
      if (shellType === "kimi-code") {
        lastDefaults.model = kimiCodeModel;
      }
      if (shellType === "opencode") {
        lastDefaults.model = opencodeModel.trim() || undefined;
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
    setMuseModel("");
    setPiModel("");
    setKimiCodeModel(KIMI_CODE_MODEL_OPTIONS[0].value);
    setOpencodeModel("");
    setBridgeId("");
    setShowSuggestions(false);
    setSelectedClaudeSessionId(null);
    setSelectedClaudeSummary(null);
    setSelectedCursorSessionId(null);
    setSelectedCursorSummary(null);
    onClose();
  }, [shellType, topShell, claudeFlavor, name, workingDir, effectiveBridgeId, hostname, selectedClaudeSessionId, selectedCursorSessionId, fireworksModels, zaiModels, grokModel, museModel, antigravityModel, piModel, kimiCodeModel, opencodeModel, autoCompactWindow, onSubmit, onClose, accountBlocked, accountsLoading, accountHarness, selectedAccount, allowedAccounts, parent, policyChoices]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      if (e.key === "Enter" && e[getSubmitModifier()]) {
        e.preventDefault();
        e.stopPropagation();
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
                <option value="muse">Muse</option>
                <option value="antigravity">Antigravity</option>
                <option value="pi">Pi</option>
                <option value="kimi-code">Kimi Code</option>
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

            {shellType === "muse" && (
              <div className="mt-3">
                <label htmlFor="ns-muse-model" className="block text-sm text-[var(--text-muted)] mb-1">
                  Model
                </label>
                <input
                  id="ns-muse-model"
                  type="text"
                  value={museModel}
                  onChange={(e) => setMuseModel(e.target.value)}
                  placeholder="Optional, CLI default when blank"
                  className={INPUT_CLASS + " text-sm"}
                />
              </div>
            )}

            {shellType === "antigravity" && (
              <div className="mt-3">
                <label htmlFor="ns-antigravity-model" className="block text-sm text-[var(--text-muted)] mb-1">
                  Model
                </label>
                <input
                  id="ns-antigravity-model"
                  type="text"
                  value={antigravityModel}
                  onChange={(e) => setAntigravityModel(e.target.value)}
                  placeholder="Optional, CLI default when blank"
                  className={INPUT_CLASS + " text-sm"}
                />
              </div>
            )}

            {shellType === "kimi-code" && (
              <div className="mt-3">
                <label htmlFor="ns-kimi-code-model" className="block text-sm text-[var(--text-muted)] mb-1">
                  Model
                </label>
                <select
                  id="ns-kimi-code-model"
                  value={kimiCodeModel}
                  onChange={(e) => setKimiCodeModel(e.target.value)}
                  className={INPUT_CLASS + " text-sm"}
                >
                  {KIMI_CODE_MODEL_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {shellType === "pi" && (
              <div className="mt-3">
                <label htmlFor="ns-pi-model" className="block text-sm text-[var(--text-muted)] mb-1">
                  Model
                </label>
                <input
                  id="ns-pi-model"
                  type="text"
                  value={piModel}
                  onChange={(e) => setPiModel(e.target.value)}
                  placeholder="Optional, e.g. anthropic/claude-sonnet-4"
                  className={INPUT_CLASS + " text-sm"}
                />
              </div>
            )}

            {shellType === "opencode" && (
              <div className="mt-3">
                <label htmlFor="ns-opencode-model" className="block text-sm text-[var(--text-muted)] mb-1">
                  Model
                </label>
                <input
                  id="ns-opencode-model"
                  type="text"
                  value={opencodeModel}
                  onChange={(e) => setOpencodeModel(e.target.value)}
                  placeholder="Optional, provider/model e.g. anthropic/claude-sonnet-4-5"
                  className={INPUT_CLASS + " text-sm"}
                />
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
                onChange={(e) => {
                  bridgeEditedRef.current = true;
                  pendingRestoredBridgeIdRef.current = null;
                  setBridgeId(e.target.value);
                  setParentSessionId("");
                }}
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

          {parents.length > 0 && <div>
            <label htmlFor="ns-parent" className="block text-sm text-[var(--text-muted)] mb-1">Parent Session <span className="text-xs text-[var(--text-faint)]">(optional)</span></label>
            <select id="ns-parent" className={INPUT_CLASS + " text-sm"} value={parent?.id ?? ""} onChange={event => setParentSessionId(event.target.value)}>
              <option value="">No parent</option>
              {parents.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.id}</option>)}
            </select>
          </div>}

          <div className="space-y-3">
            {accountHarness && <div>
              <label htmlFor="ns-account" className="block text-sm text-[var(--text-muted)] mb-1">Account</label>
              <select id="ns-account" className={INPUT_CLASS + " text-sm"} value={selectedAccount} disabled={accountsLoading || choices.length === 0}
                aria-describedby="ns-account-help" onChange={event => { setAccount(event.target.value); setAccountChosen(true); setSelectedClaudeSessionId(null); setSelectedClaudeSummary(null); }}>
                {needsReplacement && <option value="" disabled>Choose an account</option>}
                {choices.length === 0 && <option value="">No allowed accounts</option>}
                {choices.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
              </select>
              <p id="ns-account-help" className="mt-1 text-xs text-[var(--text-faint)]">
                {accountsLoading ? "Loading accounts…" : parentPolicy !== undefined ? "Only accounts allowed by the parent are available." : "Uses the account configured on the selected computer."}
              </p>
              {needsReplacement && <p role="alert" className="mt-1 text-xs text-[var(--status-pending)]">The requested account could not be verified. Choose another account or retry loading accounts.</p>}
            </div>}
            {currentAccounts?.error && <div className="mt-1 flex items-center gap-2 text-xs text-[var(--status-pending)]" role="status">
              <span>{currentAccounts.error}</span>
              {currentAccounts.status === "error" && <button type="button" className="btn-ghost shrink-0" onClick={() => setAccountsReload(value => value + 1)}>Retry</button>}
            </div>}
            {incompatibleInheritance && <p role="alert" className="text-xs text-[var(--status-pending)]">This child shell cannot inherit the parent&apos;s account. Choose a compatible shell or a different parent.</p>}
            {parentDisallowsDefault && !incompatibleInheritance && <p role="alert" className="text-xs text-[var(--status-pending)]">The parent does not allow the default account required by this child shell. Choose a compatible shell or a different parent.</p>}
            {policyUnavailable && <p role="alert" className="text-xs text-[var(--status-pending)]">The child account restrictions cannot be verified. Load the account list or update the restrictions before creating this session.</p>}
            <div>
              <label className="flex min-h-9 items-center gap-2 text-sm text-[var(--text-muted)]">
                <input type="checkbox" checked={allowedAccounts !== undefined} disabled={accountsLoading && allowedAccounts === undefined}
                  onChange={event => setAllowedAccounts(event.target.checked ? policyChoices.map(candidate => candidate.id) : undefined)} />
                Restrict accounts for child sessions
              </label>
              {allowedAccounts !== undefined && <fieldset className="mt-1 space-y-1 rounded-[var(--radius-sm)] border border-[var(--border-default)] p-2">
                <legend className="px-1 text-xs text-[var(--text-muted)]">Allowed accounts for children</legend>
                {policyChoices.map(candidate => <label key={candidate.id} className="flex min-h-9 items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <input type="checkbox" checked={allowedAccounts.includes(candidate.id)} onChange={event => setAllowedAccounts(current => event.target.checked
                    ? [...(current ?? []), candidate.id] : (current ?? []).filter(id => id !== candidate.id))} />
                  {candidate.label}
                </label>)}
                <p className="text-xs text-[var(--text-faint)]">Selecting none prevents children from using any account.</p>
              </fieldset>}
              {parentPolicy !== undefined && allowedAccounts === undefined && <p className="text-xs text-[var(--text-faint)]">Children inherit the parent&apos;s account restrictions.</p>}
            </div>
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
                sendCommand={sendCommand}
              />
            )
          )}

          {(shellType === "claude" && selectedAccount === "default" || shellType === "zai") && effectiveBridgeId && workingDir.trim() && (
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
                sendCommand={sendCommand}
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
          <p className="text-xs text-[var(--text-faint)]">
            {getSubmitModifier() === "metaKey" ? "Cmd+Enter" : "Ctrl+Enter"} to submit
          </p>
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
              disabled={accountBlocked}
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
