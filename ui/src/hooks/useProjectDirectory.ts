"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Command, CommandResponse } from "@/types";

export type HomeProject = { id: string; name: string; bridgeId: string; homeRevision?: number };
type Send = (command: Command) => Promise<CommandResponse>;
function latestHomes(rows: HomeProject[]) {
  const winners = new Map<string, HomeProject>();
  for (const row of rows) {
    const current = winners.get(row.id);
    if (!current || (current.homeRevision ?? 0) < (row.homeRevision ?? 0)
      || ((current.homeRevision ?? 0) === (row.homeRevision ?? 0) && current.bridgeId === row.bridgeId)) winners.set(row.id, row);
  }
  return [...winners.values()];
}
function isProject(value: unknown): value is HomeProject {
  if (!value || typeof value !== "object") return false;
  const project = value as Partial<HomeProject>;
  return [project.id, project.name, project.bridgeId].every(field => typeof field === "string" && field.length > 0)
    && (project.homeRevision === undefined || Number.isSafeInteger(project.homeRevision) && project.homeRevision >= 0);
}
function cached(key: string): HomeProject[] {
  try {
    const rows = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(rows) ? latestHomes(rows.filter(isProject)) : [];
  } catch { return []; }
}

export function useProjectDirectory(account: string | null, targets: string[], send: Send, selectedProject?: HomeProject | null) {
  const key = "ftown:project-directory:" + account;
  const [directory, setDirectory] = useState({ key: "", rows: [] as HomeProject[] });
  const targetKey = JSON.stringify([...targets].sort());
  const selected = useRef(selectedProject);
  selected.current = selectedProject;
  const sendRef = useRef(send);
  sendRef.current = send;
  const accountKey = useRef(key);
  accountKey.current = key;
  const generation = useRef(0);
  const accountGeneration = useRef(0);
  const pendingCreate = useRef(new Map<string, string>());
  const update = useCallback((transform: (rows: HomeProject[]) => HomeProject[]) => {
    setDirectory(previous => {
      const rows = transform(previous.key === key ? previous.rows : cached(key));
      try { localStorage.setItem(key, JSON.stringify(rows)); } catch { /* keep the in-memory directory */ }
      return { key, rows };
    });
  }, [key]);
  useEffect(() => {
    setDirectory({ key, rows: cached(key) });
    return () => { accountGeneration.current++; };
  }, [key]);
  // Keep an in-flight read and its authority while this particular home is reachable.
  const homes = useRef(new Map<string, { reading: boolean; answered: boolean }>());
  const refresh = useCallback(async (id: string) => {
    const home = homes.current.get(id);
    if (!home || home.reading || !account || document.hidden) return;
    home.reading = true;
    const revision = generation.current;
    try {
      const project = selected.current;
      const result = await sendRef.current({ type: "list_projects", requestId: crypto.randomUUID(),
        payload: { bridgeId: id, ...(project?.bridgeId === id && { projectId: project.id }) } });
      if (homes.current.get(id) !== home || generation.current !== revision || key !== accountKey.current) return;
      const rows = (result.data as { projects?: unknown } | undefined)?.projects;
      if (!result.success || !Array.isArray(rows) || !rows.every(isProject)) return;
      home.answered = true;
      update(previous => {
        const existing = new Map(previous.map(project => [project.id, project]));
        const accepted = rows.filter(row => {
          if (row.bridgeId === id || !homes.current.get(row.bridgeId)?.answered) return true;
          const known = existing.get(row.id);
          return !!known && (row.homeRevision ?? 0) > (known.homeRevision ?? 0);
        });
        const reported = new Set(accepted.map(row => row.id));
        return latestHomes([...previous.filter(row => row.bridgeId !== id || reported.has(row.id)), ...accepted]);
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

  // A cached selection can still address the old home after a move made in another client.
  const selectedId = selectedProject?.id;
  const selectedHome = selectedProject?.bridgeId;
  useEffect(() => {
    if (selectedId && selectedHome) void refresh(selectedHome);
  }, [selectedId, selectedHome, refresh]);

  async function mutate(project: HomeProject, action: string, name?: string) {
    const reply = await send({ type: "mutate_project_board", requestId: crypto.randomUUID(),
      payload: { bridgeId: project.bridgeId, projectId: project.id, action, ...(name === undefined ? {} : {name}) } });
    if (!reply.success) throw Error(reply.error || "Project change failed");
    if (accountKey.current !== key) throw Error("The active account changed.");
    generation.current++;
    update(rows => {
      const rest = rows.filter(row => row.id !== project.id);
      return action === "delete_project" ? rest : [...rest, { ...project, name: name ?? project.name }];
    });
  }
  async function move(project: HomeProject, targetBridgeId: string) {
    if (accountKey.current !== key) throw Error("The active account changed.");
    const scope = accountGeneration.current;
    const payload = { bridgeId: project.bridgeId, projectId: project.id, action: "move_project", targetBridgeId, waitForMove: true };
    let poll = false;
    let next: unknown;
    do {
      const reply = await sendRef.current({ type: "mutate_project_board", requestId: crypto.randomUUID(),
        payload: poll ? { ...payload, poll: true } : payload });
      if (accountKey.current !== key || accountGeneration.current !== scope) throw Error("The active account changed.");
      if (!reply.success) throw Error(reply.error || "Could not move project storage.");
      const data = reply.data as { moving?: unknown; project?: unknown } | undefined;
      poll = data?.moving === true;
      next = data?.project;
    } while (poll);
    if (!isProject(next) || next.id !== project.id || next.bridgeId !== targetBridgeId ||
      (next.homeRevision ?? 0) <= (project.homeRevision ?? 0)) throw Error("The new home bridge could not be confirmed. Refresh the project directory.");
    generation.current++;
    update(rows => latestHomes([...rows, next]));
    return next;
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
  return { ensureForSession, projects: directory.key === key ? directory.rows : [], create, mutate, move };
}
