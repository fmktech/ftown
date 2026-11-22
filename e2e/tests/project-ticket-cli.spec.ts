import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { BRIDGE_HOME, E2E_DIR } from "../helpers/config";
import { bridgeApiFetch, readBridgePointer } from "../helpers/bridge-api";

const execute = promisify(execFile);

async function command<T>(home: string, args: string[], sessionId?: string): Promise<T> {
  const { stdout } = await execute(process.execPath, [join(E2E_DIR, "..", "bridge", "dist", "ftown-cli.js"), ...args, "--json"], {
    env: { ...process.env, HOME: home, FTOWN_SESSION_ID: sessionId }, timeout: 45_000,
  });
  return JSON.parse(stdout) as T;
}

test("sessions manage a project on a paired bridge using the ticket CLI", async () => {
  const otherHome = join(E2E_DIR, ".bridge-home-2");
  const homeId = readBridgePointer(otherHome).bridgeId;
  const assignee = readBridgePointer().bridgeId;
  const name = "Release " + randomUUID();
  // Pairing completes before the two bridges can accept encrypted commands.
  await expect(async () => {
    await command(BRIDGE_HOME, ["projects", "list", "--bridge", homeId]);
  }).toPass({ timeout: 45_000 });
  const { project } = await command<{ project: { id: string; bridgeId: string } }>(BRIDGE_HOME, ["projects", "create", name, "--bridge", homeId]);
  expect(project.bridgeId).toBe(homeId);
  const onHome = ["--bridge", homeId, "--project", project.id];
  let workerId: string | undefined;
  try {
    const worker = await bridgeApiFetch("POST", "/api/sessions", { body: { projectName: name, shellType: "shell", name: "Ticket worker" } });
    expect(worker.status).toBe(201);
    workerId = (worker.body as { session: { id: string } }).session.id;
    const { ticket } = await command<{ ticket: { id: string } }>(BRIDGE_HOME, ["tickets", "create", "--title", "Build", "--assignee", assignee, "--link", workerId, ...onHome], workerId);
    await command(BRIDGE_HOME, ["tickets", "comment", ticket.id, "--text", "Build verified", ...onHome], workerId);
    await command(BRIDGE_HOME, ["tickets", "update", ticket.id, "--stage", "Review", ...onHome]);
    const { ticket: child } = await command<{ ticket: { parentTicketId: string } }>(BRIDGE_HOME, ["tickets", "create", "--title", "Publish", "--parent", ticket.id, ...onHome]);
    expect(child.parentTicketId).toBe(ticket.id);
    const { comments } = await command<{ comments: { text: string }[] }>(otherHome, ["tickets", "comments", ticket.id, "--project", name]);
    expect(comments.map(comment => comment.text)).toContain("Build verified");
    const { ticket: stored } = await command<{ ticket: { stage: string; sessionIds: string[] } }>(otherHome, ["tickets", "show", ticket.id, "--project", name]);
    expect(stored.sessionIds).toContain(workerId);
    expect(stored.stage).toBe("Review");
  } finally {
    if (workerId) await bridgeApiFetch("DELETE", "/api/sessions/" + workerId);
    await command(otherHome, ["projects", "delete", project.id]);
  }
});
