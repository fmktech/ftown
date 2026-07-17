import { expect, type Page } from "@playwright/test";

/**
 * Drive the dashboard's New Loop modal (ui/src/components/LoopFormModal.tsx) to
 * create an interval-scheduled loop. The modal has no test ids, so fields are
 * targeted by their placeholder / options (stable, user-visible anchors).
 */

export type LoopHarness = "claude" | "cursor" | "codex" | "grok" | "kimi-code" | "opencode" | "shell";

export interface CreateLoopViaUiInput {
  name: string;
  /** Interval in ms; must be a whole number of seconds and >= 1000 (modal floor). */
  everyMs: number;
  /** Harness the loop runs each fire. Default "shell" (no API key / claude binary). */
  harness?: LoopHarness;
  /** The task prompt run each fire (required by the modal). */
  task: string;
  /** Optional working directory. */
  workingDir?: string;
}

/**
 * Open the New Loop modal, fill an interval loop, submit, and wait for the modal
 * to close. Assumes `page` is logged in, on /dashboard, with a bridge online —
 * the "Create a new loop" button is disabled until a bridge is present. The
 * interval is entered in SECONDS (the modal's smallest exact unit), so `everyMs`
 * must be a whole number of seconds; the modal recomputes everyMs = seconds*1000.
 * Does NOT assert the loop rendered — verify that via the loops API / Centrifugo.
 */
export async function createLoopViaUi(page: Page, input: CreateLoopViaUiInput): Promise<void> {
  const seconds = input.everyMs / 1000;
  if (!Number.isInteger(seconds) || seconds < 1) {
    throw new Error(`everyMs must be a whole number of seconds >= 1000 (got ${input.everyMs})`);
  }

  await page.locator('button[title="Create a new loop"]').click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "New Loop" })).toBeVisible();

  await dialog.getByPlaceholder("Nightly cleanup, PR triage, etc.").fill(input.name);

  // Schedule defaults to "interval"; set the unit to seconds for an exact everyMs.
  await dialog.locator('select:has(option[value="s"])').selectOption("s");
  await dialog.getByPlaceholder("5").fill(String(seconds));

  await dialog.locator('select:has(option[value="grok"])').selectOption(input.harness ?? "shell");

  if (input.workingDir !== undefined) {
    await dialog.getByPlaceholder("/path/to/project (optional)").fill(input.workingDir);
  }

  await dialog.getByPlaceholder("What should this loop do each time it fires?").fill(input.task);

  await dialog.getByRole("button", { name: "Create Loop" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}
