import { test as base } from "@playwright/test";
import { cleanupBrowserApprovals } from "./secure-browser";

/** Every test releases only the browser approvals it created, including contexts it closed. */
export const test = base.extend<{ encryptedDeviceCleanup: void }>({
  encryptedDeviceCleanup: [async ({}, use, info) => {
    await use();
    await cleanupBrowserApprovals(info.testId);
  }, { auto: true }],
});
