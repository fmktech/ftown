"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { ShellType } from "@/types";
import { BridgeInfo } from "@/hooks/useBridges";
import { BridgeExecResponse } from "@/hooks/useSessions";
import { ClaudeSessionPicker } from "./ClaudeSessionPicker";
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
  onSubmit: (prompt: string, options: { name?: string; model?: string; workingDir?: string; bridgeId?: string; shellType?: ShellType; claudeSessionId?: string; env?: Record<string, string> }) => void;
  bridges: BridgeInfo[];
  defaults?: SessionDefaults;
  bridgeExec: (command: string, workingDir: string, bridgeId: string) => Promise<BridgeExecResponse>;
}

const ZAI_TOKEN_KEY = "ftown:zaiToken";
const KIMI_TOKEN_KEY = "ftown:kimiToken";

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

function getZaiDefaultEnv(token: string): Record<string, string> {
  return {
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "GLM-4.7-Flash",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "GLM-5.1",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "GLM-5-Turbo",
    API_TIMEOUT_MS: "3000000",
  };
}

function getKimiDefaultEnv(token: string): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
    API_TIMEOUT_MS: "3000000",
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

export function NewSessionModal({ isOpen, onClose, onSubmit, bridges, defaults, bridgeExec }: NewSessionModalProps) {
  const [name, setName] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [shellType, setShellType] = useState<ShellType>("claude");
  const [bridgeId, setBridgeId] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedClaudeSessionId, setSelectedClaudeSessionId] = useState<string | null>(null);
  const [selectedClaudeSummary, setSelectedClaudeSummary] = useState<string | null>(null);
  const [zaiToken, setZaiToken] = useState("");
  const [kimiToken, setKimiToken] = useState("");

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
      setShellType(defaults.shellType ?? "claude");
      setBridgeId(defaults.bridgeId ?? "");
      setSelectedClaudeSessionId(null);
      setSelectedClaudeSummary(null);
      setZaiToken(getStoredZaiToken());
      setKimiToken(getStoredKimiToken());
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
    } else {
      const storedEnv = getStoredEnvVars();
      env = Object.keys(storedEnv).length > 0 ? storedEnv : undefined;
    }

    onSubmit("", {
      name: name.trim() || undefined,
      workingDir: workingDir.trim() || undefined,
      bridgeId: effectiveBridgeId || undefined,
      shellType,
      claudeSessionId: selectedClaudeSessionId ?? undefined,
      env,
    });

    setName("");
    setWorkingDir("");
    setShellType("claude");
    setBridgeId("");
    setShowSuggestions(false);
    setSelectedClaudeSessionId(null);
    setSelectedClaudeSummary(null);
    onClose();
  }, [shellType, name, workingDir, effectiveBridgeId, hostname, selectedClaudeSessionId, zaiToken, kimiToken, onSubmit, onClose]);

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
                onClick={() => setShellType("claude")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: shellType === "claude" ? "#00ff88" : "#0a0a0a",
                  color: shellType === "claude" ? "#0a0a0a" : "#888888",
                  border: `1px solid ${shellType === "claude" ? "#00ff88" : "#2a2a2a"}`,
                  borderRight: "none",
                  borderRadius: "4px 0 0 4px",
                  fontWeight: shellType === "claude" ? 700 : 400,
                }}
              >
                Claude
              </button>
              <button
                type="button"
                onClick={() => setShellType("zai")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: shellType === "zai" ? "#00ff88" : "#0a0a0a",
                  color: shellType === "zai" ? "#0a0a0a" : "#888888",
                  border: `1px solid ${shellType === "zai" ? "#00ff88" : "#2a2a2a"}`,
                  borderRight: "none",
                  fontWeight: shellType === "zai" ? 700 : 400,
                }}
              >
                z.ai
              </button>
              <button
                type="button"
                onClick={() => setShellType("kimi")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: shellType === "kimi" ? "#00ff88" : "#0a0a0a",
                  color: shellType === "kimi" ? "#0a0a0a" : "#888888",
                  border: `1px solid ${shellType === "kimi" ? "#00ff88" : "#2a2a2a"}`,
                  borderRight: "none",
                  fontWeight: shellType === "kimi" ? 700 : 400,
                }}
              >
                Kimi
              </button>
              <button
                type="button"
                onClick={() => setShellType("opencode")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: shellType === "opencode" ? "#00ff88" : "#0a0a0a",
                  color: shellType === "opencode" ? "#0a0a0a" : "#888888",
                  border: `1px solid ${shellType === "opencode" ? "#00ff88" : "#2a2a2a"}`,
                  borderRight: "none",
                  fontWeight: shellType === "opencode" ? 700 : 400,
                }}
              >
                opencode
              </button>
              <button
                type="button"
                onClick={() => setShellType("shell")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: shellType === "shell" ? "#00ff88" : "#0a0a0a",
                  color: shellType === "shell" ? "#0a0a0a" : "#888888",
                  border: `1px solid ${shellType === "shell" ? "#00ff88" : "#2a2a2a"}`,
                  borderRadius: "0 4px 4px 0",
                  fontWeight: shellType === "shell" ? 700 : 400,
                }}
              >
                Shell (zsh)
              </button>
            </div>

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
                />
              </div>
            )}
          </div>

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
