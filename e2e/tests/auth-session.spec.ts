import { expect } from "@playwright/test";
import { test } from "../helpers/fixtures";
import { registerAndLogin } from "../helpers/app";

test("Credentials session authorizes until normal UI signout, then fails closed", async ({ page }) => {
  const user = await registerAndLogin(page);
  const session = await page.request.get("/api/auth/session");
  expect(session.status()).toBe(200);
  expect((await session.json()).user.email).toBe(user.email);
  expect((await page.request.post("/api/auth/token")).status()).toBe(200);
  const pagesBefore = page.context().pages();

  await page.getByTitle(user.email, { exact: true }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.waitForURL("**/login");

  const signedOut = await page.request.get("/api/auth/session");
  expect(signedOut.status()).toBe(200);
  const body = await signedOut.json();
  expect(body?.user).toBeUndefined();
  expect((await page.request.post("/api/auth/token")).status()).toBe(401);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  expect(page.context().pages()).toEqual(pagesBefore);
});
