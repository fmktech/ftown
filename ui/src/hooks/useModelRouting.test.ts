import { describe, expect, it, vi } from "vitest";
import { MODEL_ROUTING_INVALID_FILE_MESSAGE, MODEL_ROUTING_UNSUPPORTED_MESSAGE, ModelRoutingController } from "./useModelRouting";
import type { Command, CommandResponse } from "@/types";
import type { ModelRoutingConfig, ModelRoutingSnapshot } from "../../../bridge/src/quota/types";

const config = (steering = ""): ModelRoutingConfig => ({
  version: 1,
  tiers: [{ name: "complex", description: "Hard development", picks: [{ provider: "claude", model: "opus", effort: "high" }], guidance: "" }],
  steering,
});
const snapshot = (steering = ""): ModelRoutingSnapshot => ({
  schema: 1,
  config: config(steering),
  cached: false,
  report: {
    generatedAt: "2026-11-13T10:00:00.000Z",
    providers: [{ provider: "claude", status: "ok", plan: "max", windows: [{ kind: "five_hour", usedPercent: 20, resetsAt: "2026-11-13T12:00:00.000Z", windowMinutes: 300, note: null }], source: "live", observedAt: "2026-11-13T10:00:00.000Z", message: null }],
    routing: [{ provider: "claude", availability: "available", leftPercent: 80, bindingWindow: "five_hour", resetsAt: "2026-11-13T12:00:00.000Z", resetsInMinutes: 120, runway: 2, reason: "Plenty left." }],
    models: [{ provider: "claude", status: "ok", models: [{ id: "opus", name: "Opus", isDefault: true, description: null, contextTokens: 200000, efforts: ["low", "high"], defaultEffort: "high" }], source: "live", observedAt: "2026-11-13T10:00:00.000Z", message: null, modelFlag: "--model <id>", effortFlag: "--effort <level>" }],
    routingConfig: { status: "ok", path: "/home/u/.ftown/model-routing.json", errors: [] },
    tiers: [{ name: "complex", description: "Hard development", picks: [{ provider: "claude", model: "opus", effort: "high", modelName: "Opus", availability: "available", leftPercent: 80, resetsAt: "2026-11-13T12:00:00.000Z", scopedLimits: [], problem: null, checked: true }], guidance: "" }],
    steering,
  },
});
const ok = (data: unknown): CommandResponse => ({ requestId: "r", success: true, data });
const fail = (error: string): CommandResponse => ({ requestId: "r", success: false, error });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const make = (send: (command: Command) => Promise<CommandResponse>) => new ModelRoutingController(send, () => {}, () => "req");

describe("model routing controller", () => {
  it("loads a snapshot addressed to the bridge", async () => {
    const send = vi.fn(async (_command: Command) => ok(snapshot()));
    const c = make(send);
    expect(c.get("a").status).toBe("idle");
    const pending = c.load("a", true);
    expect(c.get("a").status).toBe("loading");
    await pending;
    expect(send).toHaveBeenCalledWith({ type: "get_model_routing", requestId: "req", payload: { bridgeId: "a", refresh: true } });
    expect(c.get("a")).toMatchObject({ status: "ready", error: null, saving: false });
    expect(c.get("a").snapshot?.config.tiers[0]?.name).toBe("complex");
  });

  it("omits refresh on a normal load", async () => {
    const send = vi.fn(async (_command: Command) => ok(snapshot()));
    await make(send).load("a");
    expect(send.mock.calls[0]?.[0].payload).toEqual({ bridgeId: "a" });
  });

  it("treats a malformed reply as an error", async () => {
    const c = make(async () => ok({ schema: 1, config: "nope" }));
    await c.load("a");
    expect(c.get("a").status).toBe("error");
    expect(c.get("a").snapshot).toBeNull();
    expect(c.get("a").error).toMatch(/does not understand/);
  });

  it("reports an old bridge as unsupported", async () => {
    const c = make(async () => fail("Unknown command type: get_model_routing"));
    await c.load("a");
    expect(c.get("a")).toMatchObject({ status: "unsupported", error: MODEL_ROUTING_UNSUPPORTED_MESSAGE });
    const other = make(async () => fail("Unknown command type: get_bridge_update"));
    await other.load("a");
    expect(other.get("a").status).toBe("error");
  });

  it("surfaces other failures and thrown errors as errors", async () => {
    const c = make(async () => fail("approval_required"));
    await c.load("a");
    expect(c.get("a")).toMatchObject({ status: "error", error: "approval_required" });
    const t = make(async () => { throw new Error("get_model_routing timed out"); });
    await t.load("a");
    expect(t.get("a")).toMatchObject({ status: "error", error: "get_model_routing timed out" });
  });

  it("ignores a stale reply superseded by a newer load", async () => {
    const first = deferred<CommandResponse>(); const second = deferred<CommandResponse>();
    const replies = [first.promise, second.promise];
    const c = make(() => replies.shift()!);
    const a = c.load("a"); const b = c.load("a", true);
    second.resolve(ok(snapshot("new"))); await b;
    first.resolve(ok(snapshot("old"))); await a;
    expect(c.get("a").status).toBe("ready");
    expect(c.get("a").snapshot?.config.steering).toBe("new");
  });

  it("does not let a failing stale reply override a newer success", async () => {
    const first = deferred<CommandResponse>();
    const replies = [first.promise, Promise.resolve(ok(snapshot("fresh")))];
    const c = make(() => replies.shift()!);
    const a = c.load("a"); await c.load("a");
    first.resolve(fail("boom")); await a;
    expect(c.get("a")).toMatchObject({ status: "ready", error: null });
  });

  it("saves, then reloads the snapshot without refresh", async () => {
    const send = vi.fn(async (command: Command) => command.type === "set_model_routing" ? ok({ schema: 1, saved: true, errors: [] }) : ok(snapshot("saved")));
    const c = make(send);
    const outcome = await c.save("a", config("saved"));
    expect(outcome).toEqual({ saved: true, snapshot: snapshot("saved") });
    expect(send.mock.calls[0]?.[0]).toEqual({ type: "set_model_routing", requestId: "req", payload: { bridgeId: "a", config: config("saved") } });
    expect(send.mock.calls[1]?.[0].payload).toEqual({ bridgeId: "a" });
    expect(c.get("a")).toMatchObject({ status: "ready", saving: false });
    expect(c.get("a").snapshot?.config.steering).toBe("saved");
  });

  it("returns validation errors without reloading", async () => {
    const send = vi.fn(async (_command: Command) => ok({ schema: 1, saved: false, errors: ["tiers[0].name must be a slug."] }));
    const c = make(send);
    expect(await c.save("a", config())).toEqual({ saved: false, errors: ["tiers[0].name must be a slug."] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(c.get("a").saving).toBe(false);
  });

  it("flags saving while in flight and refuses a second concurrent save", async () => {
    const reply = deferred<CommandResponse>();
    const send = vi.fn((command: Command) => command.type === "set_model_routing" ? reply.promise : Promise.resolve(ok(snapshot())));
    const c = make(send);
    const first = c.save("a", config());
    expect(c.get("a").saving).toBe(true);
    expect(await c.save("a", config())).toMatchObject({ saved: false });
    reply.resolve(ok({ schema: 1, saved: true, errors: [] }));
    expect(await first).toEqual({ saved: true, snapshot: snapshot() });
    expect(send.mock.calls.filter(([command]) => command.type === "set_model_routing")).toHaveLength(1);
  });

  it("sends overwriteInvalid only when it is true", async () => {
    const send = vi.fn(async (command: Command) => command.type === "set_model_routing" ? ok({ schema: 1, saved: true, errors: [] }) : ok(snapshot()));
    const c = make(send);
    await c.save("a", config(), { overwriteInvalid: true });
    await c.save("a", config(), { overwriteInvalid: false });
    await c.save("a", config());
    const saves = send.mock.calls.map(([command]) => command).filter(command => command.type === "set_model_routing");
    expect(saves.map(command => command.payload)).toEqual([
      { bridgeId: "a", config: config(), overwriteInvalid: true },
      { bridgeId: "a", config: config() },
      { bridgeId: "a", config: config() },
    ]);
  });

  it("surfaces a save blocked by an invalid file, and clears it on the next save", async () => {
    const replies = [ok({ schema: 1, saved: false, errors: [], invalidFileBlocked: true }), ok({ schema: 1, saved: false, errors: ["The routing file is invalid."], invalidFileBlocked: true })];
    const send = vi.fn(async (command: Command) => command.type === "set_model_routing" ? (replies.shift() ?? ok({ schema: 1, saved: true, errors: [] })) : ok(snapshot()));
    const c = make(send);
    expect(c.get("a").invalidFileBlocked).toBe(false);
    expect(await c.save("a", config())).toEqual({ saved: false, errors: [MODEL_ROUTING_INVALID_FILE_MESSAGE], invalidFileBlocked: true });
    expect(c.get("a")).toMatchObject({ invalidFileBlocked: true, saving: false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await c.save("a", config(), { overwriteInvalid: true })).toEqual({ saved: false, errors: ["The routing file is invalid."], invalidFileBlocked: true });
    expect(c.get("a").invalidFileBlocked).toBe(true);
    expect(await c.save("a", config(), { overwriteInvalid: true })).toEqual({ saved: true, snapshot: snapshot() });
    expect(c.get("a").invalidFileBlocked).toBe(false);
  });

  it("does not report an ordinary rejection as blocked", async () => {
    const c = make(async () => ok({ schema: 1, saved: false, errors: ["bad"], invalidFileBlocked: "yes" }));
    expect(await c.save("a", config())).toEqual({ saved: false, errors: ["bad"] });
    expect(c.get("a").invalidFileBlocked).toBe(false);
  });

  it("maps save failures, unknown command and malformed results to errors", async () => {
    expect(await make(async () => fail("Unknown command type: set_model_routing")).save("a", config())).toEqual({ saved: false, errors: [MODEL_ROUTING_UNSUPPORTED_MESSAGE] });
    expect(await make(async () => fail("disk full")).save("a", config())).toEqual({ saved: false, errors: ["disk full"] });
    expect(await make(async () => ({ requestId: "r", success: false, error: "permission_denied", data: { code: "permission_denied" } })).save("a", config())).toEqual({ saved: false, errors: ["This device does not have control permission for this computer."] });
    expect(await make(async () => ok({ saved: "yes" })).save("a", config())).toMatchObject({ saved: false });
  });

  it("keeps saving set until the follow-up load finishes", async () => {
    const setReply = deferred<CommandResponse>();
    const getReply = deferred<CommandResponse>();
    const send = vi.fn((command: Command) => command.type === "set_model_routing" ? setReply.promise : getReply.promise);
    const c = make(send);
    const pending = c.save("a", config("saved"));
    expect(c.get("a").saving).toBe(true);
    setReply.resolve(ok({ schema: 1, saved: true, errors: [] }));
    await vi.waitFor(() => { if (!send.mock.calls.some(([command]) => command.type === "get_model_routing")) throw new Error("reload not started"); });
    expect(c.get("a").saving).toBe(true);
    getReply.resolve(ok(snapshot("saved")));
    await expect(pending).resolves.toEqual({ saved: true, snapshot: snapshot("saved") });
    expect(c.get("a").saving).toBe(false);
  });

  it("returns no snapshot and keeps the previous one when the follow-up load fails", async () => {
    const replies: CommandResponse[] = [ok(snapshot("before")), ok({ schema: 1, saved: true, errors: [] }), fail("reload failed")];
    const c = make(async () => replies.shift()!);
    await c.load("a");
    const outcome = await c.save("a", config("draft-on-disk"));
    expect(outcome).toEqual({ saved: true, snapshot: null });
    expect(c.get("a")).toMatchObject({ status: "error", saving: false });
    expect(c.get("a").snapshot?.config.steering).toBe("before");
    expect(c.get("a").snapshot?.report.steering).toBe("before");
  });

  it("clears invalidFileBlocked when a later load is not invalid", async () => {
    const send = vi.fn(async (command: Command) => command.type === "set_model_routing"
      ? ok({ schema: 1, saved: false, errors: [], invalidFileBlocked: true })
      : ok(snapshot("fresh")));
    const c = make(send);
    await c.save("a", config());
    expect(c.get("a").invalidFileBlocked).toBe(true);
    await c.load("a");
    expect(c.get("a")).toMatchObject({ status: "ready", invalidFileBlocked: false });
  });

  it("keeps invalidFileBlocked when a later load is still invalid", async () => {
    const invalid = snapshot("file");
    invalid.report.routingConfig = { status: "invalid", path: "/p", errors: ["bad json"] };
    const send = vi.fn(async (command: Command) => command.type === "set_model_routing"
      ? ok({ schema: 1, saved: false, errors: [], invalidFileBlocked: true })
      : ok(invalid));
    const c = make(send);
    await c.save("a", config());
    expect(c.get("a").invalidFileBlocked).toBe(true);
    await c.load("a");
    expect(c.get("a")).toMatchObject({ status: "ready", invalidFileBlocked: true });
    expect(c.get("a").snapshot?.report.routingConfig.status).toBe("invalid");
  });

  it("does not clear invalidFileBlocked when the later load fails", async () => {
    const replies: CommandResponse[] = [ok({ schema: 1, saved: false, errors: [], invalidFileBlocked: true }), fail("network")];
    const c = make(async () => replies.shift()!);
    await c.save("a", config());
    expect(c.get("a").invalidFileBlocked).toBe(true);
    await c.load("a");
    expect(c.get("a")).toMatchObject({ status: "error", invalidFileBlocked: true });
  });

  it("leaves bridge B unchanged when a late reply for bridge A arrives", async () => {
    const lateA = deferred<CommandResponse>();
    const bridgeB = deferred<CommandResponse>();
    const newerA = deferred<CommandResponse>();
    const replies = [lateA.promise, bridgeB.promise, newerA.promise];
    const c = make(() => replies.shift()!);
    const firstA = c.load("a");
    const loadB = c.load("b");
    const secondA = c.load("a", true);
    bridgeB.resolve(ok(snapshot("from-b")));
    await loadB;
    newerA.resolve(ok(snapshot("from-a")));
    await secondA;
    lateA.resolve(ok(snapshot("stale-a")));
    await firstA;
    expect(c.get("b")).toMatchObject({ status: "ready", error: null });
    expect(c.get("b").snapshot?.config.steering).toBe("from-b");
    expect(c.get("a").snapshot?.config.steering).toBe("from-a");
    expect(c.get("a").snapshot?.report.routing[0]?.provider).toBe("claude");
  });
});
