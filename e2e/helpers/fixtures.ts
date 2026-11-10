import { test as base } from "@playwright/test";
import { takeEnrolledBrowsers } from "./passkey";
import { revokeDevices } from "./ledger-admin";

/**
 * The suite's test object. A signed-in browser is a ledger device that every
 * paired bridge of its account trusts. The shared account A is used by the
 * whole run and holds at most 128 browsers, so every browser a test enrolled
 * through signIn() is removed from its account's ledger again (passkey-signed
 * revoke_device) after the test.
 */
export const test = base.extend<{ enrolledBrowserCleanup: void }>({
  enrolledBrowserCleanup: [async ({}, use, info) => {
    await use();
    for (const { account, endpointIds } of takeEnrolledBrowsers(info.testId)) await revokeDevices(endpointIds, account);
  }, { auto: true }],
});
