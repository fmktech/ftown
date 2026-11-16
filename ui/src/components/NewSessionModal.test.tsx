// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NewSessionModal } from "./NewSessionModal";

vi.mock("./ClaudeSessionPicker", () => ({ ClaudeSessionPicker: () => null }));
vi.mock("./CursorSessionPicker", () => ({ CursorSessionPicker: () => null }));
vi.mock("./EnvVarsEditor", () => ({ default: () => null, getStoredEnvVars: () => ({}) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
      bridges={[]}
      bridgeExec={vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }))}
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
