// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionAttentionAlert } from "./SessionAttentionAlert";

afterEach(cleanup);

describe("SessionAttentionAlert", () => {
  it("acknowledges the request when the user opens its session", () => {
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

    expect(onDismiss).toHaveBeenCalledWith("worker-1");
    expect(onOpen).toHaveBeenCalledWith("worker-1");
  });
});
