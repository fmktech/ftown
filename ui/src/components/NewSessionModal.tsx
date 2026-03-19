"use client";

import { useState, useCallback } from "react";

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (prompt: string, options: { name?: string; model?: string; workingDir?: string }) => void;
}

const MODELS = [
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

export function NewSessionModal({ isOpen, onClose, onSubmit }: NewSessionModalProps) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("sonnet");
  const [workingDir, setWorkingDir] = useState("");

  const handleSubmit = useCallback(() => {
    if (!prompt.trim()) return;

    onSubmit(prompt.trim(), {
      name: name.trim() || undefined,
      model,
      workingDir: workingDir.trim() || undefined,
    });

    setPrompt("");
    setName("");
    setModel("sonnet");
    setWorkingDir("");
    onClose();
  }, [prompt, name, model, workingDir, onSubmit, onClose]);

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
              disabled={!prompt.trim()}
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
