// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUpdateNotice } from "./AppUpdateNotice";

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
describe("application build notice", () => {
  it("stays quiet on the same build or a failed request", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: "same" }) }).mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetcher); render(<AppUpdateNotice buildId="same" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens accessibly, focuses Later, suppresses the build, restores focus, and announces a later build", async () => {
    let latest = "new-build"; const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ buildId: latest }) }));
    vi.stubGlobal("fetch", fetcher); const reload = vi.fn();
    render(<><button>Prior control</button><AppUpdateNotice buildId="old-build" reload={reload} /></>);
    const prior = screen.getByRole("button", { name: "Prior control" }); prior.focus();
    const dialog = await screen.findByRole("dialog", { name: "App update available" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(/A new version is ready/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Later" })); expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(document.activeElement).toBe(prior);
    fireEvent(document, new Event("visibilitychange")); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); expect(screen.queryByRole("dialog")).toBeNull();
    latest = "newer-build"; fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByRole("dialog", { name: "App update available" })).toBeTruthy(); expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload" })); expect(reload).toHaveBeenCalledOnce();
  });
  it("Escape suppresses the build and restores focus without reloading", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ buildId: "new" }) })); vi.stubGlobal("fetch", fetcher);
    const reload = vi.fn(); render(<><button>Prior control</button><AppUpdateNotice buildId="old" reload={reload} /></>);
    const prior = screen.getByRole("button", { name: "Prior control" }); prior.focus();
    const dialog = await screen.findByRole("dialog", { name: "App update available" }); fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(document.activeElement).toBe(prior); expect(reload).not.toHaveBeenCalled();
    fireEvent(document, new Event("visibilitychange")); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("dismisses backdrop clicks but not clicks inside the dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ buildId: "new" }) })));
    const reload = vi.fn(); render(<AppUpdateNotice buildId="old" reload={reload} />);
    const dialog = await screen.findByRole("dialog", { name: "App update available" });
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({ left: 100, top: 100, right: 400, bottom: 300, width: 300, height: 200, x: 100, y: 100, toJSON: () => ({}) });
    fireEvent.click(dialog, { clientX: 150, clientY: 150 }); expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByText(/A new version is ready/)); expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(dialog, { clientX: 20, clientY: 20 }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sessionStorage.getItem("ftown:app-update-later")).toBe("new"); expect(reload).not.toHaveBeenCalled();
  });
  it("waits for an existing dialog to close before opening", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ buildId: "new" }) })));
    const existing = document.createElement("dialog"); existing.setAttribute("open", ""); document.body.append(existing);
    try {
      render(<AppUpdateNotice buildId="old" />);
      const pending = await screen.findByText("App update available");
      const dialog = pending.closest("dialog")!; expect(dialog.open).toBe(false);
      existing.remove(); await waitFor(() => expect(dialog.open).toBe(true));
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Later" }));
    } finally { existing.remove(); }
  });
});

it.each(["dialog", "alertdialog"])("defers while a visible custom %s is open and resumes when hidden", async role => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ buildId: "new" }) })));
  const wrapper = document.createElement("div"); const existing = document.createElement("div");
  existing.setAttribute("role", role); existing.setAttribute("aria-modal", "true");
  const control = document.createElement("button"); control.textContent = "Existing modal control"; existing.append(control); wrapper.append(existing); document.body.append(wrapper); control.focus();
  try {
    render(<AppUpdateNotice buildId="old" />);
    const pending = await screen.findByText("App update available"); const dialog = pending.closest("dialog")!;
    expect(dialog.open).toBe(false); expect(document.activeElement).toBe(control);
    wrapper.style.display = "none";
    await waitFor(() => expect(dialog.open).toBe(true)); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Later" }));
  } finally { wrapper.remove(); }
});

it("does not block on hidden custom or closed native dialogs", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ buildId: "new" }) })));
  const hidden = document.createElement("div"); hidden.setAttribute("role", "dialog"); hidden.setAttribute("aria-modal", "true"); hidden.hidden = true;
  const closed = document.createElement("dialog"); closed.setAttribute("role", "alertdialog"); closed.setAttribute("aria-modal", "true"); document.body.append(hidden, closed);
  try { render(<AppUpdateNotice buildId="old" />); const dialog = await screen.findByRole("dialog", { name: "App update available" }); expect((dialog as HTMLDialogElement).open).toBe(true); }
  finally { hidden.remove(); closed.remove(); }
});
