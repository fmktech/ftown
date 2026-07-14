"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SkillEditorProps, SkillFile } from "./types";
import { SKILL_PATH_RE } from "./types";

type ListState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; files: SkillFile[] };

type FileState =
  | { phase: "idle" }
  | { phase: "reading"; relPath: string }
  | { phase: "read-error"; relPath: string; message: string }
  | { phase: "open"; relPath: string; draft: string; pristine: string };

type SaveState =
  | { phase: "clean" }
  | { phase: "saving" }
  | { phase: "saved" }
  | { phase: "error"; message: string };

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function SkillEditor({ listSkills, readSkill, writeSkill }: SkillEditorProps) {
  const [list, setList] = useState<ListState>({ phase: "loading" });
  const [file, setFile] = useState<FileState>({ phase: "idle" });
  const [save, setSave] = useState<SaveState>({ phase: "clean" });
  const [pendingSwitch, setPendingSwitch] = useState<SkillFile | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readSeq = useRef(0);

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const openFile = useCallback(
    async (relPath: string) => {
      setPendingSwitch(null);
      setSave({ phase: "clean" });
      if (!SKILL_PATH_RE.test(relPath)) {
        setFile({ phase: "read-error", relPath, message: `Invalid skill path: ${relPath}` });
        return;
      }
      const seq = ++readSeq.current;
      setFile({ phase: "reading", relPath });
      try {
        const content = await readSkill(relPath);
        if (readSeq.current !== seq) return; // a newer open superseded this read
        setFile({ phase: "open", relPath, draft: content, pristine: content });
      } catch (err) {
        if (readSeq.current !== seq) return;
        setFile({ phase: "read-error", relPath, message: errorMessage(err) });
      }
    },
    [readSkill],
  );

  const loadList = useCallback(
    async (autoSelect: boolean) => {
      setList({ phase: "loading" });
      try {
        const files = await listSkills();
        setList({ phase: "ready", files });
        const current = fileRef.current;
        const hasOpen =
          current.phase === "open" ||
          current.phase === "reading" ||
          current.phase === "read-error";
        if (autoSelect && !hasOpen && files.length > 0) {
          void openFile(files[0].relPath);
        }
      } catch (err) {
        setList({ phase: "error", message: errorMessage(err) });
      }
    },
    [listSkills, openFile],
  );

  useEffect(() => {
    void loadList(true);
  }, [loadList]);

  const dirty = file.phase === "open" && file.draft !== file.pristine;
  const saving = save.phase === "saving";
  const openRelPath =
    file.phase === "open" || file.phase === "reading" || file.phase === "read-error"
      ? file.relPath
      : null;
  const openName = openRelPath ? openRelPath.split("/").pop() ?? openRelPath : null;

  const handleSelect = (f: SkillFile) => {
    if (saving) return;
    if (f.relPath === openRelPath) return;
    if (dirty) {
      setPendingSwitch(f);
      return;
    }
    void openFile(f.relPath);
  };

  const doSave = useCallback(async (): Promise<boolean> => {
    const current = fileRef.current;
    if (current.phase !== "open") return false;
    if (!SKILL_PATH_RE.test(current.relPath)) {
      setSave({ phase: "error", message: `Invalid skill path: ${current.relPath}` });
      return false;
    }
    setSave({ phase: "saving" });
    try {
      await writeSkill(current.relPath, current.draft);
      setFile({ ...current, pristine: current.draft });
      setSave({ phase: "saved" });
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => {
        setSave((s) => (s.phase === "saved" ? { phase: "clean" } : s));
      }, 2000);
      return true;
    } catch (err) {
      setSave({ phase: "error", message: errorMessage(err) });
      return false;
    }
  }, [writeSkill]);

  const handleRevert = () => {
    if (file.phase !== "open") return;
    setFile({ ...file, draft: file.pristine });
    setSave({ phase: "clean" });
  };

  const handleSaveAndSwitch = async () => {
    const target = pendingSwitch;
    if (!target) return;
    const ok = await doSave();
    if (ok) void openFile(target.relPath);
  };

  const btn =
    "rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex h-full min-h-0 text-zinc-200">
      {/* Left rail: skill file list */}
      <div className="flex w-56 shrink-0 flex-col border-r border-zinc-800">
        <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Skills
          </span>
          <button
            type="button"
            className={btn}
            title="Reload skill list"
            aria-label="Reload skill list"
            onClick={() => void loadList(true)}
            disabled={list.phase === "loading"}
          >
            &#8635;
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {list.phase === "loading" && (
            <div className="px-3 py-2 text-xs text-zinc-500">Loading skills…</div>
          )}
          {list.phase === "error" && (
            <div className="px-3 py-2 text-xs">
              <div className="text-red-400">{list.message}</div>
              <button type="button" className={`${btn} mt-2`} onClick={() => void loadList(true)}>
                Retry
              </button>
            </div>
          )}
          {list.phase === "ready" && list.files.length === 0 && (
            <div className="px-3 py-2 text-xs text-zinc-500">
              No skills found (factory/skills/*.md)
            </div>
          )}
          {list.phase === "ready" &&
            list.files.map((f) => {
              const selected = f.relPath === openRelPath;
              return (
                <button
                  key={f.relPath}
                  type="button"
                  onClick={() => handleSelect(f)}
                  className={`block w-full truncate px-3 py-1.5 text-left text-sm ${
                    selected
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                  }`}
                >
                  {f.name}
                </button>
              );
            })}
        </div>
      </div>

      {/* Right: editor */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {openRelPath === null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            {list.phase === "ready" && list.files.length === 0
              ? "No skills found (factory/skills/*.md)"
              : "Select a skill file"}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
              <span className="truncate font-mono text-xs text-zinc-400">{openRelPath}</span>
              {dirty && (
                <span className="text-xs text-amber-400" title="Unsaved changes">
                  &#9679;
                </span>
              )}
              <span className="flex-1" />
              {save.phase === "saving" && (
                <span className="text-xs text-zinc-500">saving…</span>
              )}
              {save.phase === "saved" && <span className="text-xs text-zinc-500">saved</span>}
              {save.phase === "error" && (
                <span className="max-w-64 truncate text-xs text-red-400" title={save.message}>
                  {save.message}
                </span>
              )}
              <button
                type="button"
                className={btn}
                onClick={() => void doSave()}
                disabled={!dirty || saving}
              >
                Save
              </button>
              <button
                type="button"
                className={btn}
                onClick={handleRevert}
                disabled={!dirty || saving}
              >
                Revert
              </button>
            </div>

            {pendingSwitch && (
              <div className="flex flex-wrap items-center gap-2 border-b border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                <span>Unsaved changes in {openName}</span>
                <button
                  type="button"
                  className={btn}
                  onClick={() => void handleSaveAndSwitch()}
                  disabled={saving}
                >
                  Save &amp; switch
                </button>
                <button
                  type="button"
                  className={btn}
                  onClick={() => {
                    const target = pendingSwitch;
                    if (target) void openFile(target.relPath);
                  }}
                  disabled={saving}
                >
                  Discard &amp; switch
                </button>
                <button
                  type="button"
                  className={btn}
                  onClick={() => setPendingSwitch(null)}
                  disabled={saving}
                >
                  Stay
                </button>
              </div>
            )}

            {file.phase === "reading" && (
              <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
                Loading {openName}…
              </div>
            )}
            {file.phase === "read-error" && (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
                <div className="text-red-400">{file.message}</div>
                <button type="button" className={btn} onClick={() => void openFile(file.relPath)}>
                  Retry
                </button>
              </div>
            )}
            {file.phase === "open" && (
              <textarea
                value={file.draft}
                onChange={(e) => {
                  const draft = e.target.value;
                  setFile((prev) => (prev.phase === "open" ? { ...prev, draft } : prev));
                  setSave((s) => (s.phase === "error" || s.phase === "saved" ? { phase: "clean" } : s));
                }}
                spellCheck={false}
                disabled={saving}
                className="min-h-0 flex-1 resize-none bg-zinc-950 p-4 font-mono text-sm text-zinc-200 outline-none placeholder:text-zinc-600 disabled:opacity-60"
                placeholder="(empty file)"
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
