// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LoginPage from "./page";
const auth = vi.hoisted(() => ({ signIn: vi.fn(), push: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: auth.signIn }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: auth.push }) }));
beforeEach(() => { vi.clearAllMocks(); auth.signIn.mockResolvedValue({ ok: true }); });
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
async function submit(returnTo: string) {
  window.history.replaceState(null, "", `/login?returnTo=${encodeURIComponent(returnTo)}`);
  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "test-only-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
  await waitFor(() => expect(auth.push).toHaveBeenCalledOnce());
}
it("continues a public computer code after login without putting fragment secrets in the destination", async () => {
  await submit("/pair?code=ABCD-EFGH"); expect(auth.push).toHaveBeenCalledWith("/pair?code=ABCD-EFGH");
  expect(auth.signIn).toHaveBeenCalledWith("credentials", { email: "owner@example.test", password: "test-only-password", redirect: false });
});
it("continues the captured device approval route", async () => { await submit("/devices/approve"); expect(auth.push).toHaveBeenCalledWith("/devices/approve"); });
it("rejects hostile or secret-bearing return destinations", async () => { await submit("//evil.test/pair#account=private"); expect(auth.push).toHaveBeenCalledWith("/dashboard"); });
