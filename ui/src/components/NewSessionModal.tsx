"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { ShellType } from "@/types";
import { BridgeInfo } from "@/hooks/useBridges";

export interface SessionDefaults {
  name?: string;
  workingDir?: string;
  bridgeId?: string;
  shellType?: ShellType;
}

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (prompt: string, options: { name?: string; model?: string; workingDir?: string; bridgeId?: string; shellType?: ShellType }) => void;
  bridges: BridgeInfo[];
  defaults?: SessionDefaults;
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

export function NewSessionModal({ isOpen, onClose, onSubmit, bridges, defaults }: NewSessionModalProps) {
  const [name, setName] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [shellType, setShellType] = useState<ShellType>("claude");
  const [bridgeId, setBridgeId] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);

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
    }
  }, [isOpen, defaults]);

  const handleSubmit = useCallback(() => {
    if (hostname && workingDir.trim()) {
      storePath(hostname, workingDir.trim());
    }

    onSubmit("", {
      name: name.trim() || undefined,
      workingDir: workingDir.trim() || undefined,
      bridgeId: effectiveBridgeId || undefined,
      shellType,
    });

    setName("");
    setWorkingDir("");
    setShellType("claude");
    setBridgeId("");
    setShowSuggestions(false);
    onClose();
  }, [shellType, name, workingDir, effectiveBridgeId, hostname, onSubmit, onClose]);

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
        className="w-full max-w-lg border border-[#2a2a2a] bg-[#111111] rounded-lg p-6"
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
                  borderTop: shellType === "claude" ? "1px solid #00ff88" : "1px solid #2a2a2a",
                  borderRight: shellType === "claude" ? "1px solid #00ff88" : "1px solid #2a2a2a",
                  borderBottom: shellType === "claude" ? "1px solid #00ff88" : "1px solid #2a2a2a",
                  borderLeft: shellType === "claude" ? "1px solid #00ff88" : "1px solid #2a2a2a",
                  borderRadius: "4px 0 0 4px",
                  fontWeight: shellType === "claude" ? 700 : 400,
                }}
              >
                Claude
              </button>
              <button
                type="button"
                onClick={() => setShellType("shell")}
                className="px-4 py-2 text-sm font-mono transition-colors"
                style={{
                  background: shellType === "shell" ? "#00ff88" : "#0a0a0a",
                  color: shellType === "shell" ? "#0a0a0a" : "#888888",
                  borderTop: shellType === "shell" ? "1px solid #00ff88" : "1px solid #2a2a2a",
                  borderRight: shellType === "shell" ? "1px solid #00ff88" : "1px solid #2a2a2a",
                  borderBottom: shellType === "shell" ? "1px solid #00ff88" : "1px solid #2a2a2a",
                  borderLeft: "none",
                  borderRadius: "0 4px 4px 0",
                  fontWeight: shellType === "shell" ? 700 : 400,
                }}
              >
                Shell (zsh)
              </button>
            </div>
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
