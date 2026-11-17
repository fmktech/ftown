// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PickRow, Subscriptions } from "./ModelRoutingDialog";
import type { ProviderQuota, ProviderRouting, QuotaReport } from "../../../bridge/src/quota/types";

afterEach(cleanup);

function quota(provider: ProviderQuota["provider"], account: string | undefined, usedPercent: number): ProviderQuota {
  return { provider, ...(account ? { account } : {}), status: "ok", plan: "Subscription", source: "live", observedAt: "2026-11-16T12:00:00Z", message: null,
    windows: [{ kind: "five_hour", usedPercent, resetsAt: null, windowMinutes: 300, note: null }] };
}
function routing(provider: ProviderRouting["provider"], account: string | undefined, availability: ProviderRouting["availability"]): ProviderRouting {
  return { provider, ...(account ? { account } : {}), availability, leftPercent: 10, bindingWindow: "five_hour", resetsAt: null, resetsInMinutes: null, runway: null, reason: `${account ?? "default"} availability` };
}
function report(): QuotaReport {
  return { generatedAt: "2026-11-16T12:00:00Z", providers: [quota("claude", "work", 90), quota("claude", "default", 10), quota("codex", undefined, 20), quota("codex", "coding", 30)],
    routing: [routing("claude", "work", "low"), routing("claude", "default", "available"), routing("codex", undefined, "available"), routing("codex", "coding", "exhausted")],
    models: [], routingConfig: { status: "missing", path: "model-routing.json", errors: [] }, tiers: [], steering: "" };
}

it("renders a separate row per provider/account, default first, with each account's own quota and availability", () => {
  render(<Subscriptions report={report()} />);
  expect(screen.getAllByRole("listitem").map(row => row.getAttribute("aria-label"))).toEqual([
    "claude account default", "codex account default", "codex account coding", "claude account work",
  ]);
  const work = screen.getByRole("listitem", { name: "claude account work" });
  expect(within(work).getByText("10% left")).toBeTruthy();
  expect(within(work).getByText("low")).toBeTruthy();
  expect(within(work).queryByText("available")).toBeNull();
  expect(within(screen.getByRole("listitem", { name: "claude account default" })).getByText("90% left")).toBeTruthy();
  expect(within(screen.getByRole("listitem", { name: "codex account coding" })).getByText("exhausted")).toBeTruthy();
});

it("shows an account's authentication problem without borrowing another account's status", () => {
  const value = report();
  value.providers[0] = { ...value.providers[0], status: "auth", message: "Sign in to Work" };
  render(<Subscriptions report={value} />);
  const work = screen.getByRole("listitem", { name: "claude account work" });
  expect(within(work).getByText("login needed").title).toBe("Sign in to Work");
  expect(within(work).queryByText("10% left")).toBeNull();
  expect(within(screen.getByRole("listitem", { name: "claude account default" })).getByText("90% left")).toBeTruthy();
});

it("clears an account when changing provider and keeps it for model or effort changes", () => {
  const value = report();
  const model = (id: string) => ({ id, name: id, isDefault: id === "one", description: null, contextTokens: null, efforts: ["low", "high"], defaultEffort: "low" });
  value.models = [
    { provider: "claude", account: "work", status: "ok", models: [model("one"), model("two")], source: "live", observedAt: value.generatedAt, message: null, modelFlag: "--model", effortFlag: "--effort" },
    { provider: "codex", account: "default", status: "ok", models: [model("one")], source: "live", observedAt: value.generatedAt, message: null, modelFlag: "--model", effortFlag: "--effort" },
  ];
  const onChange = vi.fn();
  const pick = { provider: "claude" as const, account: "work", model: "one", effort: "low" };
  render(<ul><PickRow report={value} tierIndex={0} index={0} count={1} disabled={false} originName={null} pick={pick} onChange={onChange} onMove={vi.fn()} onRemove={vi.fn()} /></ul>);
  fireEvent.change(screen.getByLabelText("Tier 1 pick 1 model"), { target: { value: "two" } });
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ account: "work", model: "two" }));
  fireEvent.change(screen.getByLabelText("Tier 1 pick 1 effort"), { target: { value: "high" } });
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ account: "work", effort: "high" }));
  fireEvent.change(screen.getByLabelText("Tier 1 pick 1 CLI"), { target: { value: "codex" } });
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "codex" }));
  expect(onChange.mock.calls.at(-1)?.[0]).not.toHaveProperty("account");
});
