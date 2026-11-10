import { test as base } from "@playwright/test";
import { takeEnrolledBrowsers } from "./passkey";
import { revokeDevices } from "./ledger-admin";

/**
 * The suite's test object. A signed-in browser is a ledger device that every
 * paired bridge trusts. The ONE account is shared by the whole run and holds at
 * most 128 browsers, so every browser a test enrolled through signIn() is
 * removed from the ledger again (passkey-signed revoke_device) after the test.
 */
export const test = base.extend<{ enrolledBrowserCleanup: void }>({
  enrolledBrowserCleanup: [async ({}, use, info) => {
    await use();
    const owned = takeEnrolledBrowsers(info.testId);
    if (owned.length) await revokeDevices(owned);
  }, { auto: true }],
});
