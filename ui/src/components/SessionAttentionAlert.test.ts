// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionAttentionAlert } from "./SessionAttentionAlert";

afterEach(cleanup);

describe("SessionAttentionAlert", () => {
  it("opens the session without dismissing the request", () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render(createElement(SessionAttentionAlert, {
      attention: {
        sessionId: "worker-1",
        sessionName: "Worker",
        title: "Session is asking a question",
        message: "Choose an environment",
        receivedAt: 10,
      },
      isDesktop: true,
      onOpen,
      onDismiss,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Open session" }));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith("worker-1");
  });

  it("dismisses only when the explicit dismissal control is used", () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render(createElement(SessionAttentionAlert, {
      attention: { sessionId: "worker-1", sessionName: "Worker", title: "Review requested", message: "Review the result", receivedAt: 10 },
      isDesktop: false, onOpen, onDismiss,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith("worker-1");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("wraps an unbroken full message without truncating the popup body", () => {
    const message = "x".repeat(2000);
    render(createElement(SessionAttentionAlert, {
      attention: { sessionId: "worker-1", sessionName: "Worker", title: "Review requested", message, receivedAt: 10 },
      isDesktop: false, onOpen: vi.fn(), onDismiss: vi.fn(),
    }));
    const body = screen.getByText(`Worker: ${message}`);
    expect(body.textContent).toBe(`Worker: ${message}`);
    expect(body.style.overflowWrap).toBe("anywhere");
    expect(body.style.getPropertyValue("-webkit-line-clamp")).toBe("");
  });
});
