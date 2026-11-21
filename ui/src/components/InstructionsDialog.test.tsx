// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Command } from "@/types";
import { InstructionsDialog } from "./InstructionsDialog";

afterEach(cleanup);
it("loads both files and saves only the chosen scope on the selected bridge", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  const send = vi.fn(async (command: Command) => ({
    success: true, requestId: command.requestId, data: { text: (command.payload as {scope: string}).scope + " guidance" },
  }));
  render(<InstructionsDialog bridgeId="desk" name="Desktop" send={send} close={vi.fn()} />);
  await screen.findByDisplayValue("global guidance");
  fireEvent.change(await screen.findByDisplayValue("bridge guidance"), { target: { value: "updated" } });
  fireEvent.click(screen.getByRole("button", { name: "Save bridge instructions" }));
  await screen.findByText("Saved");
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "set_instructions", payload: { bridgeId: "desk", scope: "bridge", text: "updated" } }));
  expect(screen.getByDisplayValue("global guidance")).toBeTruthy();
});
