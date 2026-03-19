"use client";

import { useState, useCallback } from "react";
import { ShellType } from "@/types";
import { BridgeInfo } from "@/hooks/useBridges";

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (prompt: string, options: { name?: string; model?: string; workingDir?: string; bridgeId?: string; shellType?: ShellType }) => void;
  bridges: BridgeInfo[];
}

const MODELS = [
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

export function NewSessionModal({ isOpen, onClose, onSubmit, bridges }: NewSessionModalProps) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("sonnet");
  const [workingDir, setWorkingDir] = useState("");
  const [shellType, setShellType] = useState<ShellType>("claude");
  const [bridgeId, setBridgeId] = useState("");

  const effectiveBridgeId = bridgeId || (bridges.length > 0 ? bridges[0].bridgeId : "");

  const canSubmit = shellType === "shell" || prompt.trim().length > 0;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;

    onSubmit(shellType === "shell" ? "" : prompt.trim(), {
      name: name.trim() || undefined,
      model: shellType === "shell" ? undefined : model,
      workingDir: workingDir.trim() || undefined,
      bridgeId: effectiveBridgeId || undefined,
      shellType,
    });

    setPrompt("");
    setName("");
    setModel("sonnet");
    setWorkingDir("");
    setShellType("claude");
    setBridgeId("");
    onClose();
  }, [canSubmit, shellType, prompt, name, model, workingDir, effectiveBridgeId, onSubmit, onClose]);

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

          {shellType === "claude" && (
            <div>
              <label className="block text-sm text-[#888888] mb-1">Prompt *</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should Claude do?"
                rows={4}
                autoFocus
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88] resize-none"
                onKeyDown={handleKeyDown}
              />
            </div>
          )}

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

          {shellType === "claude" && (
            <div>
              <label className="block text-sm text-[#888888] mb-1">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] focus:outline-none focus:border-[#00ff88]"
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm text-[#888888] mb-1">Working Directory</label>
            <input
              type="text"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder="/path/to/project (optional)"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#e0e0e0] placeholder-[#555] focus:outline-none focus:border-[#00ff88]"
              onKeyDown={handleKeyDown}
            />
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
              disabled={!canSubmit}
              className="px-4 py-2 bg-[#00ff88] text-[#0a0a0a] font-bold rounded text-sm hover:bg-[#00cc6e] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
