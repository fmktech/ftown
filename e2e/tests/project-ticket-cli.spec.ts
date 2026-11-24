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

    await command(BRIDGE_HOME, ["boards", "columns", "add", "QA", ...onHome]);
    await command(BRIDGE_HOME, ["tickets", "update", ticket.id, "--stage", "QA", ...onHome]);
    await command(BRIDGE_HOME, ["boards", "columns", "rename", "QA", "Verification", ...onHome]);
    await command(BRIDGE_HOME, ["boards", "columns", "remove", "Verification", "--move-to", "Done", ...onHome]);
    const moved = await command<{ ticket: { stage: string } }>(otherHome, ["tickets", "show", ticket.id, "--project", name]);
    expect(moved.ticket.stage).toBe("Done");
    await command(BRIDGE_HOME, ["tickets", "delete", ticket.id, ...onHome]);
    await command(BRIDGE_HOME, ["boards", "delete", ...onHome]);
    await command(BRIDGE_HOME, ["boards", "create", ...onHome]);
    const fresh = await command<{ tickets: unknown[] }>(otherHome, ["tickets", "list", "--project", name]);
    expect(fresh.tickets).toEqual([]);
  } finally {
    if (workerId) await bridgeApiFetch("DELETE", "/api/sessions/" + workerId);
    await command(otherHome, ["projects", "delete", project.id]);
  }
});

test("sessions manage a project discussion on a paired bridge and receive thread mail", async () => {
  const home = join(E2E_DIR, ".bridge-home-2");
  const homeId = readBridgePointer(home).bridgeId;
  const workerBridge = readBridgePointer().bridgeId;
  const name = "Discussion " + randomUUID();
  await expect(async () => {
    await command(BRIDGE_HOME, ["projects", "list", "--bridge", homeId]);
  }).toPass({ timeout: 45_000 });
  const { project } = await command<{ project: { id: string } }>(home, ["projects", "create", name]);
  const local = ["--project", project.id];
  const remote = [...local, "--bridge", homeId];
  let workerId: string | undefined;
  try {
    const worker = await bridgeApiFetch("POST", "/api/sessions", { body: { projectName: name, shellType: "shell", name: "ARM tester" } });
    expect(worker.status).toBe(201);
    workerId = (worker.body as { session: { id: string } }).session.id;
    await command(BRIDGE_HOME, ["discuss", "channels", "create", "builds", ...remote], workerId);
    const { id: thread } = await command<{ id: string }>(BRIDGE_HOME, ["discuss", "post", "builds", "--title", "ARM build", "--text", "I can verify ARM.", ...remote], workerId);
    type Post = { seq: number; text: string; author: { name: string; sessionId?: string; bridgeId?: string } };
    const initial = await command<{ posts: Post[] }>(home, ["discuss", "activity", "builds", ...local]);
    expect(initial.posts).toHaveLength(1);
    expect(initial.posts[0].author).toMatchObject({ name: "ARM tester", sessionId: workerId, bridgeId: workerBridge });
    const mention = "Please run the smoke suite @" + workerBridge + "/" + workerId;
    await command(home, ["discuss", "reply", thread, "--text", mention, ...local]);
    type Notice = { body: string; from: string; threadId: string; discussion: { projectId: string; homeBridgeId?: string } };
    const inbox = async () => {
      const { body } = await bridgeApiFetch("GET", "/api/sessions/" + workerId + "/inbox?peek=1&all=1");
      return (body as { messages: Notice[] }).messages;
    };
    const mentioned = async () => (await inbox()).find(message => message.body.includes("Please run the smoke suite"));
    await expect.poll(mentioned, { timeout: 45_000 }).toMatchObject({
      from: "project-discussion", threadId: thread, discussion: { projectId: project.id, homeBridgeId: homeId },
    });
    const notice = (await mentioned())!;
    expect(notice.body).toContain(`ftown discuss reply ${thread} --project ${project.id} --bridge ${homeId}`);

    // Invoke the tool registered by the shipped extension with the recipient's bridge credentials.
    type Tool = { name: string; execute(call: string, params: Record<string, string | undefined>): Promise<{ isError?: boolean; details: unknown }> };
    const tools: Tool[] = [];
    const extensionPath = join(E2E_DIR, "..", "bridge", "pi-extension", "ftown.js");
    const { registerFtownPiExtension } = await import(extensionPath);
    registerFtownPiExtension({ registerTool: (tool: Tool) => tools.push(tool), registerCommand() {}, on() {} }, {
      harness: "omp", env: { ...process.env, HOME: BRIDGE_HOME, FTOWN_SESSION_ID: workerId }, readBridgePointer: () => readBridgePointer(),
    });
    const answer = "ARM smoke suite passed.";
    const result = await tools.find(tool => tool.name === "ftown_discuss")!.execute("verify-arm", {
      operation: "reply", text: answer, project: notice.discussion.projectId, bridge: notice.discussion.homeBridgeId, threadId: notice.threadId,
    });
    expect(result.isError, JSON.stringify(result.details)).toBeFalsy();
    await command(BRIDGE_HOME, ["discuss", "follow", thread, ...remote], workerId);
    await command(home, ["discuss", "reply", thread, "--text", "CI is green", ...local]);
    await expect.poll(async () => (await inbox()).some(message => message.body.includes("CI is green")), { timeout: 45_000 }).toBe(true);
    const later = await command<{ posts: Post[] }>(BRIDGE_HOME, ["discuss", "activity", "builds", "--after", String(initial.posts[0].seq), ...remote]);
    expect(later.posts.map(post => post.text)).toEqual([mention, answer, "CI is green"]);
    expect(later.posts[1].author).toMatchObject({ sessionId: workerId, bridgeId: workerBridge });
    await command(BRIDGE_HOME, ["discuss", "unfollow", thread, ...remote], workerId);
    const ticketId = randomUUID();
    await command(BRIDGE_HOME, ["discuss", "create-ticket", thread, "--id", ticketId, "--title", "Release on ARM", ...remote], workerId);
    await command(home, ["discuss", "channels", "rename", "builds", "releases", ...local]);
    await command(home, ["discuss", "channels", "archive", "releases", ...local]);
    const linked = await command<{ threads: { id: string; ticketId: string }[] }>(BRIDGE_HOME, ["discuss", "for-ticket", ticketId, ...remote]);
    expect(linked.threads).toMatchObject([{ id: thread, ticketId }]);
  } finally {
    if (workerId) await bridgeApiFetch("DELETE", "/api/sessions/" + workerId);
    await command(home, ["projects", "delete", project.id]);
  }
});
