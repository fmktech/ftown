// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NewSessionModal, type SessionDefaults } from "./NewSessionModal";
import type { Command, CommandResponse, Session } from "@/types";

vi.mock("./ClaudeSessionPicker", () => ({ ClaudeSessionPicker: ({ account }: { account: string }) => <div data-testid="claude-session-picker-account">{account}</div> }));
vi.mock("./CursorSessionPicker", () => ({ CursorSessionPicker: () => null }));
vi.mock("./EnvVarsEditor", () => ({ default: () => null, getStoredEnvVars: () => ({}) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: { platform },
  });
}

function renderModal() {
  const onSubmit = vi.fn(async () => undefined);
  render(
    <NewSessionModal
      isOpen
      onClose={vi.fn()}
      onSubmit={onSubmit}
      defaults={{ projectName: "Test project" }}
      bridges={[]}
      sendCommand={vi.fn(async () => ({ requestId: "test", success: true }))}
    />,
  );
  return onSubmit;
}

it("submits with Ctrl+Enter and shows the Ctrl hint on Linux", () => {
  setPlatform("Linux x86_64");
  const onSubmit = renderModal();

  expect(screen.getByText("Ctrl+Enter to submit")).toBeTruthy();
  fireEvent.keyDown(screen.getByLabelText(/Session Name/), { key: "Enter", ctrlKey: true });
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("submits with Cmd+Enter and shows the Cmd hint on macOS", () => {
  setPlatform("MacIntel");
  const onSubmit = renderModal();

  expect(screen.getByText("Cmd+Enter to submit")).toBeTruthy();
  fireEvent.keyDown(screen.getByLabelText(/Session Name/), { key: "Enter", metaKey: true });
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("prefers userAgentData platform when selecting the shortcut", () => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: { platform: "Windows" },
  });
  const onSubmit = renderModal();

  expect(screen.getByText("Ctrl+Enter to submit")).toBeTruthy();
  fireEvent.keyDown(screen.getByLabelText(/Session Name/), { key: "Enter", ctrlKey: true });
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

const bridges = [
  { bridgeId: "a", hostname: "first", clientId: "first", connectedAt: "2026-11-16" },
  { bridgeId: "b", hostname: "second", clientId: "second", connectedAt: "2026-11-16" },
];
const defaultAccounts = [
  { id: "default", harness: "claude", isDefault: true },
  { id: "default", harness: "codex", isDefault: true },
];
const accounts = [
  ...defaultAccounts,
  { id: "work", harness: "claude", label: "Work", isDefault: false },
  { id: "spare", harness: "claude", isDefault: false },
  { id: "coding", harness: "codex", label: "Coding", isDefault: false },
];
const parent: Session = { id: "parent", name: "Manager", bridgeId: "a", shellType: "claude", status: "running", createdAt: "2026-11-16", updatedAt: "2026-11-16", account: "work", allowedAccounts: ["work", "coding"] };

function accountsModal(overrides: { sessions?: Session[]; defaults?: SessionDefaults; sendCommand?: (command: Command) => Promise<CommandResponse> } = {}) {
  const onSubmit = vi.fn(async () => undefined);
  const sendCommand = overrides.sendCommand ?? vi.fn(async () => ({ requestId: "accounts", success: true, data: { accounts } }));
  const result = render(<NewSessionModal isOpen onClose={vi.fn()} onSubmit={onSubmit} bridges={bridges} sessions={overrides.sessions} defaults={{ projectName: "Test project", ...overrides.defaults }} sendCommand={sendCommand} />);
  return { ...result, onSubmit, sendCommand };
}

it("lists default first, filters accounts by harness, and submits the selected account and child policy", async () => {
  const { onSubmit, sendCommand } = accountsModal();
  const picker = screen.getByLabelText("Account") as HTMLSelectElement;
  await waitFor(() => expect(picker.disabled).toBe(false));
  expect(Array.from(picker.options).map(option => option.value)).toEqual(["default", "spare", "work"]);
  expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "get_accounts", payload: { bridgeId: "a" } }), { retryBridgeStarting: false });
  fireEvent.change(picker, { target: { value: "work" } });
  fireEvent.click(screen.getByLabelText("Restrict accounts for child sessions"));
  const childPolicy = screen.getByRole("group", { name: "Allowed accounts for children" });
  fireEvent.click(within(childPolicy).getByLabelText("Default account"));
  fireEvent.click(within(childPolicy).getByLabelText("spare (claude)"));
  fireEvent.click(screen.getByRole("button", { name: "Create Session" }));
  expect(onSubmit).toHaveBeenCalledWith("", expect.objectContaining({ account: "work", allowedAccounts: ["coding", "work"] }));
});

it("shows Claude sessions for the selected non-default account", async () => {
  accountsModal({ defaults: { bridgeId: "a", workingDir: "/Users/example/", account: "work" } });
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("work"));
  expect((await screen.findByTestId("claude-session-picker-account")).textContent).toBe("work");
});

it("retries the account read briefly when the bridge reports it is starting", async () => {
  vi.useFakeTimers();
  const sendCommand = vi.fn()
    .mockResolvedValueOnce({ requestId: "starting", success: false, error: "Bridge is starting", data: { code: "bridge_starting", retryable: true } })
    .mockResolvedValueOnce({ requestId: "starting", success: false, error: "Bridge is starting", data: { code: "bridge_starting", retryable: true } })
    .mockResolvedValueOnce({ requestId: "starting", success: false, error: "Bridge is starting", data: { code: "bridge_starting", retryable: true } })
    .mockResolvedValueOnce({ requestId: "starting", success: false, error: "Bridge is starting", data: { code: "bridge_starting", retryable: true } })
    .mockResolvedValueOnce({ requestId: "ready", success: true, data: { accounts } });
  accountsModal({ sendCommand });
  await act(async () => { await vi.runAllTimersAsync(); });
  expect(sendCommand).toHaveBeenCalledTimes(5);
  expect(sendCommand).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "get_accounts", requestId: expect.any(String) }), { retryBridgeStarting: false });
  expect(new Set(sendCommand.mock.calls.map(([command]) => command.requestId)).size).toBe(5);
  expect(sendCommand.mock.calls[0][1]).toEqual({ retryBridgeStarting: false });
  expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false);
  expect(screen.getByRole("option", { name: "Work (work)" })).toBeTruthy();
});

it("shows the typed starting message after the picker exhausts its bounded backoff", async () => {
  vi.useFakeTimers();
  const sendCommand = vi.fn(async () => ({ requestId: "starting", success: false, error: "Bridge is starting", data: { code: "bridge_starting", retryable: true } }));
  accountsModal({ sendCommand });
  await act(async () => { await vi.runAllTimersAsync(); });
  expect(sendCommand).toHaveBeenCalledTimes(5);
  expect(screen.getByRole("status").textContent).toContain("This computer is still starting");
});

it("shows the typed bridge startup refusal from session creation", async () => {
  const onSubmit = vi.fn(async () => { throw new Error("Bridge is starting"); });
  render(<NewSessionModal isOpen onClose={vi.fn()} onSubmit={onSubmit} bridges={bridges} defaults={{ projectName: "Test project" }}
    sendCommand={vi.fn(async () => ({ requestId: "accounts", success: true, data: { accounts } }))} />);
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Create Session" }));
  expect(await screen.findByText("Bridge is starting")).toBeTruthy();
});

it.each([
  ["missing a default", [defaultAccounts[0]]],
  ["duplicate default for one harness", [...defaultAccounts, defaultAccounts[0]]],
  ["a non-boolean default flag", [...defaultAccounts, { id: "work", harness: "claude", isDefault: "false" }]],
  ["a default flag on a registered id", [...defaultAccounts, { id: "work", harness: "claude", isDefault: true }]],
  ["duplicate registered ids across harnesses", [...defaultAccounts, { id: "work", harness: "claude", isDefault: false }, { id: "work", harness: "codex", isDefault: false }]],
])("rejects malformed account lists: %s", async (_description, rows) => {
  accountsModal({ sendCommand: vi.fn(async () => ({ requestId: "bad", success: true, data: { accounts: rows } })) });
  expect(await screen.findByText("Could not read the accounts returned by this computer.")).toBeTruthy();
  expect(screen.queryByRole("option", { name: "work" })).toBeNull();
});

it("switches to Codex accounts and hides the account picker for other shells", async () => {
  const { onSubmit } = accountsModal();
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Shell Type"), { target: { value: "codex" } });
  const picker = screen.getByLabelText("Account") as HTMLSelectElement;
  expect(Array.from(picker.options).map(option => option.value)).toEqual(["default", "coding"]);
  fireEvent.change(picker, { target: { value: "coding" } });
  fireEvent.change(screen.getByLabelText("Shell Type"), { target: { value: "shell" } });
  expect(screen.queryByLabelText("Account")).toBeNull();
  expect(screen.getByLabelText("Restrict accounts for child sessions")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create Session" }));
  expect(onSubmit).toHaveBeenCalledWith("", expect.not.objectContaining({ account: expect.anything() }));
});

it("passes a child policy for other shells without an explicit account", async () => {
  const { onSubmit } = accountsModal({ sessions: [{ ...parent, account: undefined, allowedAccounts: ["default", "work"] }] });
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText(/Parent Session/), { target: { value: "parent" } });
  fireEvent.change(screen.getByLabelText("Shell Type"), { target: { value: "shell" } });
  expect(screen.queryByLabelText("Account")).toBeNull();
  fireEvent.click(screen.getByLabelText("Restrict accounts for child sessions"));
  fireEvent.click(screen.getByRole("button", { name: "Create Session" }));
  expect(onSubmit).toHaveBeenCalledWith("", expect.objectContaining({ parentSessionId: "parent", allowedAccounts: ["default", "work"] }));
  expect(onSubmit).toHaveBeenCalledWith("", expect.not.objectContaining({ account: expect.anything() }));
});

it.each(["default", "work"])("blocks another shell from inheriting a stored %s account", async account => {
  const { onSubmit } = accountsModal({ sessions: [{ ...parent, account, allowedAccounts: ["default", "work"] }] });
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText(/Parent Session/), { target: { value: "parent" } });
  fireEvent.change(screen.getByLabelText("Shell Type"), { target: { value: "shell" } });
  expect(screen.getByRole("alert").textContent).toContain("cannot inherit the parent's account");
  expect((screen.getByRole("button", { name: "Create Session" }) as HTMLButtonElement).disabled).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("blocks another shell when the parent has no stored account but disallows default", async () => {
  const { onSubmit } = accountsModal({ sessions: [{ ...parent, account: undefined, allowedAccounts: ["work"] }] });
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText(/Parent Session/), { target: { value: "parent" } });
  fireEvent.change(screen.getByLabelText("Shell Type"), { target: { value: "shell" } });
  expect(screen.getByRole("alert").textContent).toContain("does not allow the default account");
  expect((screen.getByRole("button", { name: "Create Session" }) as HTMLButtonElement).disabled).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("intersects a selected child and its resolved parent's policy and inherits the resolved account", async () => {
  const root = { ...parent, id: "root", name: "Root", account: "spare", allowedAccounts: ["spare", "work"] };
  const child = { ...parent, id: "child", name: "Child", parentSessionId: "root", account: "work", allowedAccounts: ["spare", "coding"] };
  const { onSubmit } = accountsModal({ sessions: [root, child] });
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText(/Parent Session/), { target: { value: "child" } });
  const picker = screen.getByLabelText("Account") as HTMLSelectElement;
  expect(Array.from(picker.options).map(option => option.value)).toEqual(["spare"]);
  expect(picker.value).toBe("spare");
  fireEvent.click(screen.getByRole("button", { name: "Create Session" }));
  expect(onSubmit).toHaveBeenCalledWith("", expect.objectContaining({ parentSessionId: "child", account: "spare" }));
});

it("treats an unavailable resolved parent account as default while keeping the direct policy", async () => {
  const alias = { ...parent, id: "alias", parentSessionId: "missing", allowedAccounts: ["default", "work"] };
  const { onSubmit } = accountsModal({ sessions: [alias] });
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText(/Parent Session/), { target: { value: "alias" } });
  expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("default");
  fireEvent.click(screen.getByRole("button", { name: "Create Session" }));
  expect(onSubmit).toHaveBeenCalledWith("", expect.objectContaining({ parentSessionId: "alias", account: "default" }));
});

it.each([
  { requestId: "error", success: false, error: "unavailable" },
  { requestId: "old", success: false, error: "Unknown command type: get_accounts" },
  { requestId: "missing", success: true, data: { accounts: defaultAccounts } },
])("does not silently replace an unverifiable cloned account ($requestId)", async response => {
  const { onSubmit } = accountsModal({ defaults: { account: "work" }, sendCommand: vi.fn(async () => response) });
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("requested account could not be verified");
  expect((screen.getByRole("button", { name: "Create Session" }) as HTMLButtonElement).disabled).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "default" } });
  expect((screen.getByRole("button", { name: "Create Session" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Create Session" }));
  expect(onSubmit).toHaveBeenCalledWith("", expect.objectContaining({ account: "default" }));
});

it("resets an explicit replacement when the shell changes", async () => {
  accountsModal({ defaults: { account: "missing" } });
  await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "work" } });
  expect((screen.getByRole("button", { name: "Create Session" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Shell Type"), { target: { value: "codex" } });
  expect((screen.getByRole("button", { name: "Create Session" }) as HTMLButtonElement).disabled).toBe(true);
});

it.each(["loading", "error", "unsupported", "stale"])("protects cloned child restrictions when accounts are %s", async status => {
  let resolveRequest!: (response: CommandResponse) => void;
  const sendCommand = vi.fn(() => new Promise<CommandResponse>(resolve => { resolveRequest = resolve; }));
  const { onSubmit } = accountsModal({ defaults: { shellType: "shell", allowedAccounts: ["work"] }, sendCommand });
  if (status !== "loading") {
    await act(async () => resolveRequest(status === "stale" ? { requestId: status, success: true, data: { accounts: defaultAccounts } }
      : { requestId: status, success: false, error: status === "unsupported" ? "Unknown command type: get_accounts" : "unavailable" }));
  }
  expect(screen.getByText(/child account restrictions cannot be verified/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Create Session" }) as HTMLButtonElement).disabled).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
  if (status === "error" || status === "unsupported") expect(screen.getByRole("status").textContent).toMatch(/accounts|bridge/i);
  if (status === "loading") {
    await act(async () => resolveRequest({ requestId: status, success: true, data: { accounts } }));
    fireEvent.click(screen.getByRole("button", { name: "Create Session" }));
    expect(onSubmit).toHaveBeenCalledWith("", expect.objectContaining({ allowedAccounts: ["work"] }));
  }
});

it("inherits the parent account and only offers accounts allowed by the parent", async () => {
  const { onSubmit } = accountsModal({ sessions: [parent] });
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText(/Parent Session/), { target: { value: "parent" } });
  const picker = screen.getByLabelText("Account") as HTMLSelectElement;
  expect(Array.from(picker.options).map(option => option.value)).toEqual(["work"]);
  expect(picker.value).toBe("work");
  fireEvent.click(screen.getByLabelText("Restrict accounts for child sessions"));
  const childPolicy = screen.getByRole("group", { name: "Allowed accounts for children" });
  expect(within(childPolicy).queryByLabelText("Default account")).toBeNull();
  expect(within(childPolicy).getAllByRole("checkbox")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Create Session" }));
  expect(onSubmit).toHaveBeenCalledWith("", expect.objectContaining({ parentSessionId: "parent", account: "work", allowedAccounts: ["coding", "work"] }));
});

it("blocks creation when the parent allows no matching account", async () => {
  accountsModal({ sessions: [{ ...parent, allowedAccounts: ["coding"] }] });
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText(/Parent Session/), { target: { value: "parent" } });
  expect((screen.getByRole("button", { name: "Create Session" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("No allowed accounts")).toBeTruthy();
});

it("discards late replies from the previous computer", async () => {
  let resolveFirst!: (response: CommandResponse) => void;
  const sendCommand = vi.fn((command: Command) => command.payload && "bridgeId" in command.payload && command.payload.bridgeId === "a"
    ? new Promise<CommandResponse>(resolve => { resolveFirst = resolve; })
    : Promise.resolve({ requestId: "b", success: true, data: { accounts: [...defaultAccounts, { id: "second", harness: "claude", isDefault: false }] } }));
  accountsModal({ sendCommand });
  fireEvent.change(screen.getByLabelText(/Bridge/), { target: { value: "b" } });
  await waitFor(() => expect(screen.getByRole("option", { name: "second" })).toBeTruthy());
  await act(async () => resolveFirst({ requestId: "a", success: true, data: { accounts } }));
  expect(screen.queryByRole("option", { name: "Work (work)" })).toBeNull();
  expect(screen.getByRole("option", { name: "second" })).toBeTruthy();
});

it("keeps default creation available and explains unsupported bridge versions", async () => {
  const { onSubmit } = accountsModal({ sendCommand: vi.fn(async () => ({ requestId: "old", success: false, error: "Unknown command type: get_accounts" })) });
  await screen.findByText("Update this computer's bridge to choose registered accounts.");
  fireEvent.click(screen.getByRole("button", { name: "Create Session" }));
  expect(onSubmit).toHaveBeenCalledWith("", expect.objectContaining({ account: "default" }));
});

it("starts a fresh modal opening with the default account after a canceled selection", async () => {
  const sendCommand = vi.fn(async () => ({ requestId: "accounts", success: true, data: { accounts } }));
  const props = { onClose: vi.fn(), onSubmit: vi.fn(), bridges, sendCommand };
  const { rerender } = render(<NewSessionModal {...props} isOpen />);
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Account"), { target: { value: "work" } });
  rerender(<NewSessionModal {...props} isOpen={false} />);
  rerender(<NewSessionModal {...props} isOpen />);
  await waitFor(() => expect((screen.getByLabelText("Account") as HTMLSelectElement).disabled).toBe(false));
  expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("default");
});

it("shows CPU, RAM and disk space beside the reporting computer", () => {
  render(<NewSessionModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} bridges={bridges}
    resourcesByBridge={new Map([["b", { sampledAt: 1, cpuPercent: 62, freeRamBytes: 4 * 2 ** 30, totalRamBytes: 16 * 2 ** 30, freeDiskBytes: 21 * 2 ** 30 }]])}
    sendCommand={vi.fn(async () => ({ requestId: "accounts", success: true, data: { accounts } }))} />);
  expect(screen.getByRole("option", { name: /second.*CPU 62%.*RAM 4.0\/16.0 GiB free.*disk 21.0 GiB free/ })).toBeTruthy();
});
