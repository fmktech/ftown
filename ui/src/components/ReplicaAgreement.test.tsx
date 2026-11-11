// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointPublic } from "@security/protocol";
import type { LedgerBridge, LedgerCheckpoint, LedgerDevice } from "@security/ledger/protocol";
import type { LedgerPeersView } from "@/lib/ledger-client";
import { ReplicaAgreement } from "./ReplicaAgreement";

afterEach(() => cleanup());
const endpoint = (id: string, kind: "browser" | "bridge"): EndpointPublic => ({ version: 1, id, ownerId: "acct", kind, publicKey: `p-${id}` });
const bridge = (bridgeId: string, label: string): LedgerBridge => ({ bridgeId, endpoint: endpoint(`${bridgeId}-key`, "bridge"), authPublicKey: "a", label, approvedAt: 1 });
const device = (id: string, label: string): LedgerDevice => ({ endpoint: endpoint(id, "browser"), authPublicKey: "a", label, approvedAt: 1 });
const checkpoint = (bridges: LedgerBridge[], devices: LedgerDevice[] = [device("self", "Laptop"), device("phone", "Phone")]): LedgerCheckpoint => ({
  version: 2, accountId: "acct", revision: 3, head: "h", authorities: [], devices, bridges, revokedDeviceIds: [], revokedBridgeIds: [],
});
const peers = (over: Partial<LedgerPeersView> = {}): LedgerPeersView => ({ head: "abcdef123456", confirmed: [], online: [], diverged: [], ...over });
const at = 1;
const text = () => screen.getByRole("status").textContent;
const view = (p: LedgerPeersView | undefined, c: LedgerCheckpoint | null) => render(<ReplicaAgreement peers={p} checkpoint={c} />);

describe("ReplicaAgreement", () => {
  it("is a polite status line", () => {
    view(peers(), checkpoint([]));
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });
  it("nothing confirmed", () => {
    view(peers(), checkpoint([]));
    expect(text()).toBe("Not confirmed by any other replica yet.");
  });
  it("counts computers and browsers, omitting a zero part, with plurals", () => {
    const c = checkpoint([bridge("b1", "Mac"), bridge("b2", "PC")]);
    const confirmed = (items: Array<["bridge" | "device", string]>) => items.map(([kind, id]) => ({ kind, id, at }));
    const online = ["b1", "b2"];
    view(peers({ online, confirmed: confirmed([["bridge", "b1"], ["bridge", "b2"], ["device", "phone"]]) }), c);
    expect(text()).toBe("Applied on 2 computers and 1 browser.");
    cleanup();
    view(peers({ online, confirmed: confirmed([["bridge", "b1"], ["bridge", "b2"]]) }), c);
    expect(text()).toBe("Applied on 2 computers.");
    cleanup();
    view(peers({ online, confirmed: confirmed([["bridge", "b1"], ["device", "phone"]]) }), c);
    expect(text()).toBe("Applied on 1 computer and 1 browser. Waiting for PC…");
    cleanup();
    view(peers({ online, confirmed: confirmed([["device", "phone"]]) }), c);
    expect(text()).toBe("Applied on 1 browser. Waiting for Mac and PC…");
  });
  it("does not count a member that left the account", () => {
    view(peers({ online: ["b1"], confirmed: [{ kind: "bridge", id: "b1", at }, { kind: "bridge", id: "gone", at }, { kind: "device", id: "ghost", at }] }), checkpoint([bridge("b1", "Mac")]));
    expect(text()).toBe("Applied on 1 computer.");
  });
  it("offline computers: one, two, three and more than three", () => {
    const four = [bridge("b1", "Mac"), bridge("b2", "PC"), bridge("b3", "Pi"), bridge("b4", "Box")];
    view(peers({ online: ["b2", "b3", "b4"], confirmed: [{ kind: "bridge", id: "b2", at }, { kind: "bridge", id: "b3", at }, { kind: "bridge", id: "b4", at }] }), checkpoint(four));
    expect(text()).toBe("Applied on 3 computers. Mac will apply it when it connects.");
    cleanup();
    view(peers({ online: ["b3", "b4"], confirmed: [{ kind: "bridge", id: "b3", at }, { kind: "bridge", id: "b4", at }] }), checkpoint(four));
    expect(text()).toBe("Applied on 2 computers. Mac and PC will apply it when they connect.");
    cleanup();
    view(peers({ online: ["b4"], confirmed: [{ kind: "bridge", id: "b4", at }] }), checkpoint(four));
    expect(text()).toBe("Applied on 1 computer. Mac, PC and Pi will apply it when they connect.");
    cleanup();
    view(peers({ online: [] }), checkpoint(four));
    expect(text()).toBe("Not confirmed by any other replica yet. 4 computers will apply it when they connect.");
  });
  it("falls back to the first 8 characters of the id for an unlabelled computer", () => {
    view(peers({ online: [] }), checkpoint([bridge("0123456789abcdef", "")]));
    expect(text()).toContain("01234567 will apply it when it connects.");
  });
  it("a diverged computer is neither waited for nor said to apply it later", () => {
    view(peers({ online: ["b1"], diverged: [{ kind: "bridge", id: "b1", head: "deadbeef", revision: 5 }] }), checkpoint([bridge("b1", "Mac")]));
    expect(text()).toBe("Not confirmed by any other replica yet.");
  });
  it("renders nothing without peers, with an empty head, or without an account", () => {
    expect(view(undefined, checkpoint([])).container.textContent).toBe("");
    expect(view(peers({ head: "" }), checkpoint([])).container.textContent).toBe("");
    expect(view(peers(), null).container.textContent).toBe("");
  });
});
