// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUpdateNotice } from "./AppUpdateNotice";

afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals(); });
describe("application build notice", () => {
  it("stays quiet on the same build or a failed request", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ buildId: "same" }) }).mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetcher); render(<AppUpdateNotice buildId="same" />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(screen.queryByText("App update available")).toBeNull();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("App update available")).toBeNull();
  });
  it("requires an explicit reload and later suppresses the same build in this tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ buildId: "new-build" }) })));
    const reload = vi.fn(); const view = render(<AppUpdateNotice buildId="old-build" reload={reload} />);
    expect(await screen.findByText("App update available")).toBeTruthy(); expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Later" })); expect(screen.queryByText("App update available")).toBeNull();
    view.unmount(); render(<AppUpdateNotice buildId="old-build" reload={reload} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); expect(screen.queryByText("App update available")).toBeNull();
    sessionStorage.clear(); cleanup(); render(<AppUpdateNotice buildId="old-build" reload={reload} />);
    expect(await screen.findByText("App update available")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Reload" })); expect(reload).toHaveBeenCalledOnce();
  });
});
