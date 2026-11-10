// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import {
  accountIdOf, authorityConsentChallenge, describeFork, ledgerChallenge, ledgerHead, ledgerLastIssuedAt, nextTransition, resolutionPlan, resolveForkTransition, verifyLedger,
} from "@security/ledger/ledger";
import { generateAuthKey } from "@security/ledger/proof";
import type { Ledger, LedgerBridge, LedgerDevice, LedgerGenesis, LedgerOperation } from "@security/ledger/protocol";
import { createSoftPasskey } from "@security/ledger/testing";
import type { SoftPasskey } from "@security/ledger/testing";
import type { LedgerClientSnapshot, LedgerDivergence } from "@/lib/ledger-client";
import { useAccountSecurity } from "@/hooks/useAccountSecurity";
import { ForkResolution, carryText, describeOperation, memberNames } from "./ForkResolution";

const RP = "ftown.test"; const ORIGIN = "https://ftown.test";
const state = vi.hoisted(() => ({ snapshot: null as unknown, client: null as unknown, listeners: new Set<() => void>() }));
vi.mock("@/hooks/useLedger", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; };
  return { useLedger: () => ({ client: state.client, snapshot: useSyncExternalStore(subscribe, () => state.snapshot as LedgerClientSnapshot) }) };
});
const publish = (snapshot: LedgerClientSnapshot) => { state.snapshot = snapshot; act(() => { for (const listener of [...state.listeners]) listener(); }); };

// ---- Real chains: soft passkeys, the shared ledger helpers, describeFork / resolutionPlan for the divergence. ----
let keyA: SoftPasskey; let keyB: SoftPasskey;
let accountId = "";
let base: Ledger;
const fx: { mine: Ledger; theirs: Ledger; several: LedgerDivergence; one: LedgerDivergence; none: LedgerDivergence; resolved: LedgerDivergence; longLabel: LedgerDivergence } = {} as never;

async function append(ledger: Ledger, key: SoftPasskey, operation: LedgerOperation): Promise<Ledger> {
  const payload = nextTransition(await verifyLedger(ledger), key.credentialId, operation, Date.now(), ledgerLastIssuedAt(ledger));
  return { genesis: ledger.genesis, transitions: [...ledger.transitions, { payload, signature: await key.sign(await ledgerChallenge(payload)) }] };
}
async function member(label: string): Promise<LedgerDevice> {
  const endpoint = await generateEndpoint(accountId, "browser", false);
  return { endpoint: endpoint.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label, approvedAt: Date.now() - 1000 };
}
async function bridgeMember(label: string): Promise<LedgerBridge> {
  const endpoint = await generateEndpoint(accountId, "bridge", false);
  return { bridgeId: endpoint.endpoint.id.slice(0, 24), endpoint: endpoint.endpoint, authPublicKey: (await generateAuthKey(false)).publicKey, label, approvedAt: Date.now() - 1000 };
}
async function divergence(mine: Ledger, theirs: Ledger, source: LedgerDivergence["source"] = "server"): Promise<LedgerDivergence> {
  const sideOf = async (chosen: Ledger, other: Ledger) => {
    try { return { carry: (await resolutionPlan(chosen, other)).carry, canKeep: true, reason: null }; } catch (error) { return { carry: [], canKeep: false, reason: (error as Error).message }; }
  };
  return { other: theirs, source, fork: await describeFork(mine, theirs), firstSeen: Date.now(), mine: await sideOf(mine, theirs), theirs: await sideOf(theirs, mine) };
}

let iphone: LedgerDevice; let homeServer: LedgerBridge; let macStudio: LedgerBridge;
beforeAll(async () => {
  keyA = await createSoftPasskey({ rpId: RP, origin: ORIGIN }); keyB = await createSoftPasskey({ rpId: RP, origin: ORIGIN });
  const genesis: LedgerGenesis = { type: "ftown_account_genesis", version: 2, rpId: RP, origins: [ORIGIN], handle: Buffer.alloc(32, 7).toString("base64url"), createdAt: Date.now() - 5000,
    authority: { credentialId: keyA.credentialId, publicKey: keyA.publicKey, label: "MacBook Touch ID", addedAt: Date.now() - 5000 } };
  accountId = await accountIdOf(genesis);
  base = { genesis: { payload: genesis, signature: await keyA.sign(await ledgerChallenge(genesis)) }, transitions: [] };
  iphone = await member("iPhone Safari"); homeServer = await bridgeMember("Home server"); macStudio = await bridgeMember("Mac Studio");
  base = await append(base, keyA, { type: "add_device", device: await member("Laptop") });
  base = await append(base, keyA, { type: "add_device", device: iphone });
  base = await append(base, keyA, { type: "add_bridge", bridge: homeServer });
  // This browser: adds a computer and removes the iPhone. The other: adds a browser and a passkey, removes the home server.
  fx.mine = await append(await append(base, keyA, { type: "add_bridge", bridge: macStudio }), keyA, { type: "revoke_device", endpointId: iphone.endpoint.id });
  const authority = { credentialId: keyB.credentialId, publicKey: keyB.publicKey, label: "YubiKey", addedAt: Date.now() - 100 };
  const consent = await keyB.sign(await authorityConsentChallenge(accountId, authority));
  fx.theirs = await append(await append(await append(base, keyA, { type: "add_device", device: await member("Tablet") }), keyA, { type: "add_authority", authority, consent }),
    keyA, { type: "revoke_bridge", bridgeId: homeServer.bridgeId });
  fx.several = await divergence(fx.mine, fx.theirs);
  // One carried item: the other branch only removed a browser.
  const removedOnly = await append(base, keyA, { type: "revoke_device", endpointId: iphone.endpoint.id });
  fx.one = await divergence(await append(base, keyA, { type: "add_device", device: await member("Tablet") }), removedOnly, "peer");
  // None carried: both only add.
  fx.none = await divergence(fx.mine.transitions.length ? await append(base, keyA, { type: "add_bridge", bridge: macStudio }) : base, await append(base, keyA, { type: "add_device", device: await member("Tablet") }), "relay");
  // A resolve_fork on the other side (a real one: Y was resolved in favour of X).
  const x = await append(base, keyA, { type: "add_bridge", bridge: macStudio });
  const y = await append(base, keyA, { type: "add_device", device: await member("Tablet") });
  const xResolved = await append(x, keyA, { ...{ type: "resolve_fork" as const }, ...(await resolveForkTransition(x, y, keyA.credentialId)).operation } as LedgerOperation);
  fx.resolved = await divergence(y, xResolved);
  const long = "L".repeat(70);
  fx.longLabel = await divergence(await append(base, keyA, { type: "add_device", device: await member("Tablet") }), await append(base, keyA, { type: "add_device", device: await member(long) }));
});

beforeEach(() => { state.listeners.clear(); });
afterEach(() => cleanup());

const resolveDivergence = vi.fn<(keep: "mine" | "theirs") => Promise<void>>();
function snapshotFor(value: LedgerDivergence | null): LedgerClientSnapshot {
  return { status: "ready", checkpoint: null, discarded: [], localOnly: { deviceIds: [], bridgeIds: [] }, signer: keyA.credentialId, pending: "none", divergence: value };
}
function Harness({ value }: { value: LedgerDivergence }) {
  const security = useAccountSecurity();
  const divergenceNow = security.snapshot.divergence;
  return divergenceNow ? <ForkResolution divergence={divergenceNow} security={security} checkpoint={null} onKept={() => undefined} /> : <p>gone {value.source}</p>;
}
function mount(value: LedgerDivergence) {
  resolveDivergence.mockReset();
  state.client = { refresh: vi.fn(async () => {}), resolveDivergence };
  state.snapshot = snapshotFor(value);
  return render(<Harness value={value} />);
}
const column = (name: string) => screen.getByRole("region", { name });
const mineColumn = () => column("This browser's history");
const otherColumn = () => column("The other history");

describe("ForkResolution", () => {
  it("shows the heading (focused), intro, source line and the collapsed common part", () => {
    mount(fx.several);
    const heading = screen.getByRole("heading", { name: "Two different histories of this account exist" });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByText("They cannot both be kept. Review what each one contains and keep one. Nothing changes until you confirm.")).toBeTruthy();
    expect(screen.getByText("The server holds the other history.")).toBeTruthy();
    expect(screen.getByText(`${fx.several.fork.fork.revision} earlier changes are identical.`)).toBeTruthy();
    expect(fx.several.fork.fork.revision).toBe(3);
    expect(screen.getByText(/Other changes to your account are turned off/)).toBeTruthy();
  });

  it.each([["peer", "One of your computers holds the other history."], ["relay", "Another replica announced the other history."]] as const)("source %s", (source, text) => {
    mount({ ...fx.several, source });
    expect(screen.getByText(text)).toBeTruthy();
  });

  it("lists each side's records in order, one sentence each with a machine-readable time", () => {
    mount(fx.several);
    const mine = within(mineColumn()).getAllByRole("listitem").slice(0, 2);
    expect(mine.map(item => item.querySelector("span")?.textContent)).toEqual(["Added computer “Mac Studio”", "Removed browser “iPhone Safari”"]);
    const first = fx.several.fork.mine[0];
    const time = mine[0].querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(new Date(first.issuedAt).toISOString());
    expect(time?.textContent).toBe(new Date(first.issuedAt).toLocaleString());
    const theirs = within(otherColumn()).getAllByRole("listitem").slice(0, 3);
    expect(theirs.map(item => item.querySelector("span")?.textContent)).toEqual(["Added browser “Tablet”", "Added passkey “YubiKey”", "Removed computer “Home server”"]);
  });

  it("renders the resolve_fork sentence from a real resolution record", () => {
    mount(fx.resolved);
    expect(within(otherColumn()).getByText("Chose this history over another one")).toBeTruthy();
  });

  it("resolves removed ids from the shared prefix, falling back to the first 8 characters", () => {
    const names = memberNames(fx.several, null);
    expect(describeOperation({ type: "revoke_device", endpointId: iphone.endpoint.id }, names).text).toBe("Removed browser “iPhone Safari”");
    expect(describeOperation({ type: "revoke_bridge", bridgeId: homeServer.bridgeId }, names).text).toBe("Removed computer “Home server”");
    expect(describeOperation({ type: "revoke_device", endpointId: "abcdefghijklmnop" }, names).text).toBe("Removed browser “abcdefgh”");
    expect(describeOperation({ type: "revoke_bridge", bridgeId: "zyxwvutsrq" }, names).text).toBe("Removed computer “zyxwvuts”");
  });

  it("says so when a column has no changes", () => {
    mount({ ...fx.none, fork: { ...fx.none.fork, theirs: [] } });
    expect(within(otherColumn()).getByText("No changes after the common part.")).toBeTruthy();
  });

  it("carry text: none", () => {
    mount(fx.none);
    expect(fx.none.mine.carry).toHaveLength(0);
    expect(within(mineColumn()).getByText("Keeping this history discards the other one's changes listed opposite.")).toBeTruthy();
  });

  it("carry text: one carried removal asks to confirm twice", () => {
    mount(fx.one);
    expect(fx.one.mine.carry).toHaveLength(1);
    expect(within(mineColumn()).getByText("Keeping this history re-applies 1 removal from the other one, then discards the rest. You will confirm 2 times.")).toBeTruthy();
    expect(within(mineColumn()).getByRole("list", { name: "Re-applied from the other history" }).textContent).toBe("Removed browser “iPhone Safari”");
  });

  it("carry text: several carried items, pluralized, listed, K = carry + 1", () => {
    mount(fx.several);
    expect(fx.several.mine.carry.map(item => item.type)).toEqual(["add_authority", "revoke_bridge"]);
    expect(within(mineColumn()).getByText("Keeping this history re-applies 1 removal and 1 passkey from the other one, then discards the rest. You will confirm 3 times.")).toBeTruthy();
    const carried = within(mineColumn()).getByRole("list", { name: "Re-applied from the other history" });
    expect(within(carried).getAllByRole("listitem").map(item => item.textContent)).toEqual(["Added passkey “YubiKey”", "Removed computer “Home server”"]);
    expect(within(otherColumn()).getByText(/re-applies 1 removal from the other one, then discards the rest. You will confirm 2 times./)).toBeTruthy();
    expect(carryText({ carry: [{ type: "revoke_device", endpointId: "a" }, { type: "revoke_device", endpointId: "b" }, { type: "revoke_bridge", bridgeId: "c" }], canKeep: true, reason: null }))
      .toBe("Keeping this history re-applies 3 removals from the other one, then discards the rest. You will confirm 4 times.");
  });

  it("the discarded list holds only added browsers and computers, never a removal or a passkey", () => {
    mount(fx.several);
    // Keeping this browser's history loses the other's Tablet; its removal and passkey are carried.
    const notes = [mineColumn(), otherColumn()].map(item => within(item).getByRole("note"));
    expect(within(notes[0]).getByText("Will be discarded:")).toBeTruthy();
    expect(within(notes[0]).getAllByRole("listitem").map(item => item.textContent)).toEqual(["Added browser “Tablet”"]);
    expect(within(notes[1]).getAllByRole("listitem").map(item => item.textContent)).toEqual(["Added computer “Mac Studio”"]);
    for (const note of notes) expect(note.textContent).not.toMatch(/Removed|passkey/);
  });

  it("says nothing is lost when nothing is", () => {
    // Keeping this browser's history: the other branch only removed a browser, which is carried.
    mount(fx.one);
    expect(within(mineColumn()).getByRole("note").textContent).toBe("Nothing will be lost.");
  });

  it.each([["ledger_limit", "This history cannot be kept: it would exceed the limit of passkeys."], ["invalid_ledger", "This history cannot be kept."]])("canKeep false (%s) disables with the reason", (reason, text) => {
    mount({ ...fx.several, theirs: { ...fx.several.theirs, canKeep: false, reason } });
    expect((within(otherColumn()).getByRole("button", { name: "Keep this history" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(otherColumn()).getByText(text)).toBeTruthy();
    expect((within(mineColumn()).getByRole("button", { name: "Keep this history" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the right side exactly once and disables both buttons while pending", async () => {
    mount(fx.several);
    let finish: () => void = () => undefined;
    resolveDivergence.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => { fireEvent.click(within(otherColumn()).getByRole("button", { name: "Keep this history" })); });
    expect(resolveDivergence).toHaveBeenCalledExactlyOnceWith("theirs");
    for (const item of screen.getAllByRole("button", { name: "Keep this history" })) expect((item as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(within(mineColumn()).getByRole("button", { name: "Keep this history" })); });
    expect(resolveDivergence).toHaveBeenCalledOnce();
    expect(within(otherColumn()).getByRole("status").textContent).toBe("Confirm with your passkey. You may be asked 2 times.");
    await act(async () => { finish(); });
  });

  it("keeping this browser's history calls mine", async () => {
    mount(fx.several);
    resolveDivergence.mockResolvedValueOnce();
    await act(async () => { fireEvent.click(within(mineColumn()).getByRole("button", { name: "Keep this history" })); });
    expect(resolveDivergence).toHaveBeenCalledExactlyOnceWith("mine");
  });

  it.each([
    ["resolution_outdated", "The other history changed. Review it again."],
    ["passkey_cancelled", "Cancelled. Nothing was changed."],
    ["ledger_limit", "Your account reached its size limit for this kind of change."],
  ])("error %s", async (code, text) => {
    mount(fx.several);
    resolveDivergence.mockRejectedValueOnce(new Error(code));
    await act(async () => { fireEvent.click(within(mineColumn()).getByRole("button", { name: "Keep this history" })); });
    expect(screen.getByRole("alert").textContent).toBe(text);
    // Both buttons are available again after a failure.
    for (const item of screen.getAllByRole("button", { name: "Keep this history" })) expect((item as HTMLButtonElement).disabled).toBe(false);
  });

  it("disappears when the divergence becomes null", () => {
    mount(fx.several);
    expect(screen.getByRole("heading", { name: /Two different histories/ })).toBeTruthy();
    publish(snapshotFor(null));
    expect(screen.queryByRole("heading", { name: /Two different histories/ })).toBeNull();
    expect(screen.getByText("gone server")).toBeTruthy();
  });

  it("truncates a long label with CSS and keeps the whole text in title", () => {
    mount(fx.longLabel);
    const long = "L".repeat(70);
    const span = within(otherColumn()).getByTitle(long);
    expect(span.className).toContain("truncate");
    expect(span.textContent).toContain(long);
  });

  it("renders labels as text, never as HTML", () => {
    const hostile = { ...fx.longLabel, fork: { ...fx.longLabel.fork, theirs: fx.longLabel.fork.theirs.map(item => item.operation.type === "add_device"
      ? { ...item, operation: { ...item.operation, device: { ...item.operation.device, label: "<img src=x onerror=alert(1)>" } } } : item) } };
    const view = mount(hostile);
    expect(view.container.querySelector("img")).toBeNull();
    expect(within(otherColumn()).getByText("Added browser “<img src=x onerror=alert(1)>”")).toBeTruthy();
  });
});
