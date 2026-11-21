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
  useEffect(() => {
    let active = true;
    let reading = false;
    const ids = JSON.parse(targetKey) as string[];
    async function refresh() {
      if (reading || !account || !ids.length || document.hidden) return;
      reading = true;
      const revision = generation.current;
      try {
        const replies = await Promise.allSettled(ids.map(async id => {
          const result = await sendRef.current({ type: "list_projects", requestId: crypto.randomUUID(), payload: { bridgeId: id } });
          const rows = (result.data as { projects?: unknown } | undefined)?.projects;
          if (!result.success || !Array.isArray(rows) || !rows.every(isProject)) throw Error("Directory unavailable");
          return { id, rows };
        }));
        if (!active || generation.current !== revision) return;
        const answers = replies.flatMap(reply => reply.status === "fulfilled" ? [reply.value] : []);
        if (!answers.length) return;
        const owners = new Set(answers.map(answer => answer.id));
        update(previous => {
          const merged = new Map(previous.filter(p => !owners.has(p.bridgeId)).map(p => [identity(p), p]));
          for (const { id, rows } of answers) {
            for (const p of rows) if (p.bridgeId === id || !owners.has(p.bridgeId)) merged.set(identity(p), p);
          }
          return [...merged.values()];
        });
      } finally { reading = false; }
    }
    void refresh();
    const timer = setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [account, key, targetKey, update]);

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
