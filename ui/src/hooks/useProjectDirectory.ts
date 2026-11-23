"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, CommandResponse } from "@/types";

export type HomeProject = { id: string; name: string; bridgeId: string };
type Send = (command: Command) => Promise<CommandResponse>;
const identity = (p: HomeProject) => JSON.stringify([p.bridgeId, p.id]);
function isProject(value: unknown): value is HomeProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<HomeProject>;
  return [project.id, project.name, project.bridgeId].every(field => typeof field === "string" && field.length > 0);
}
function cached(key: string): HomeProject[] {
  try {
    const rows = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(rows) ? rows.filter(isProject) : [];
  } catch { return []; }
}

export function useProjectDirectory(account: string | null, targets: string[], send: Send) {
  const key = "ftown:project-directory:" + account;
  const [directory, setDirectory] = useState({ key: "", rows: [] as HomeProject[] });
  const targetKey = JSON.stringify([...targets].sort());
  const sendRef = useRef(send);
  sendRef.current = send;
  const accountKey = useRef(key);
  accountKey.current = key;
  const generation = useRef(0);
  const pendingCreate = useRef(new Map<string, string>());
  const update = useCallback((transform: (rows: HomeProject[]) => HomeProject[]) => {
    setDirectory(previous => {
      const rows = transform(previous.key === key ? previous.rows : cached(key));
      try { localStorage.setItem(key, JSON.stringify(rows)); } catch { /* keep the in-memory directory */ }
      return { key, rows };
    });
  }, [key]);
  useEffect(() => { setDirectory({ key, rows: cached(key) }); }, [key]);
  // Keep an in-flight read and its authority while this particular home is reachable.
  const homes = useRef(new Map<string, { reading: boolean; answered: boolean }>());
  const refresh = useCallback(async (id: string) => {
    const home = homes.current.get(id);
    if (!home || home.reading || !account || document.hidden) return;
    home.reading = true;
    const revision = generation.current;
    try {
      const result = await sendRef.current({ type: "list_projects", requestId: crypto.randomUUID(), payload: { bridgeId: id } });
      if (homes.current.get(id) !== home || generation.current !== revision || key !== accountKey.current) return;
      const rows = (result.data as { projects?: unknown } | undefined)?.projects;
      if (!result.success || !Array.isArray(rows) || !rows.every(isProject)) return;
      home.answered = true;
      const accepted = rows.filter(row => row.bridgeId === id || !homes.current.get(row.bridgeId)?.answered);
      update(previous => {
        const merged = new Map(previous.filter(p => p.bridgeId !== id).map(p => [identity(p), p]));
        for (const p of accepted) merged.set(identity(p), p);
        return [...merged.values()];
      });
    } catch { /* Retain the last directory until this bridge responds. */ }
    finally { home.reading = false; }
  }, [account, key, update]);

  useEffect(() => {
    const current = homes.current;
    const refreshAll = () => current.forEach((_, id) => void refresh(id));
    const timer = setInterval(refreshAll, 30_000);
    document.addEventListener("visibilitychange", refreshAll);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshAll);
      current.clear();
    };
  }, [refresh]);
  useEffect(() => {
    const ids = new Set<string>(JSON.parse(targetKey));
    for (const id of homes.current.keys()) if (!ids.has(id)) homes.current.delete(id);
    for (const id of ids) if (!homes.current.has(id)) {
      homes.current.set(id, { reading: false, answered: false });
      void refresh(id);
    }
  }, [targetKey, refresh]);

  async function mutate(project: HomeProject, action: string, name?: string) {
    const reply = await send({ type: "mutate_project_board", requestId: crypto.randomUUID(),
      payload: { bridgeId: project.bridgeId, projectId: project.id, action, ...(name === undefined ? {} : {name}) } });
    if (!reply.success) throw Error(reply.error || "Project change failed");
    if (accountKey.current !== key) throw Error("The active account changed.");
    generation.current++;
    update(rows => {
      const rest = rows.filter(row => identity(row) !== identity(project));
      return action === "delete_project" ? rest : [...rest, { ...project, name: name ?? project.name }];
    });
  }
  async function create(name: string, bridgeId: string) {
    const attempt = JSON.stringify([account, bridgeId, name]);
    const id = pendingCreate.current.get(attempt) ?? crypto.randomUUID();
    pendingCreate.current.set(attempt, id);
    const project = { name, id, bridgeId };
    await mutate(project, "create_project", name);
    pendingCreate.current.delete(attempt);
    return project;
  }
  async function ensureForSession(name: string, bridgeId: string) {
    // A session may be created before this browser receives the project directory.
    const reply = await send({ type: "list_projects", requestId: crypto.randomUUID(), payload: {bridgeId} });
    const entries = (reply.data as { projects?: unknown } | undefined)?.projects;
    if (!reply.success || !Array.isArray(entries)) throw Error(reply.error || "Could not read the home bridge’s projects.");
    if (!entries.some(row => isProject(row) && row.name === name)) await create(name, bridgeId);
  }
  return { ensureForSession, projects: directory.key === key ? directory.rows : [], create, mutate };
}
