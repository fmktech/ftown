// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HeaderTooltip } from "./HeaderTooltip";

afterEach(cleanup);
it("describes the focused control and preserves its existing description and click", () => {
  const click = vi.fn();
  render(<HeaderTooltip label="Open security"><button aria-describedby="prior" onClick={click}>Security</button></HeaderTooltip>);
  const button = screen.getByRole("button");
  fireEvent.focus(button);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip.textContent).toBe("Open security");
  expect(button.getAttribute("aria-describedby")?.split(" ")).toEqual(["prior", tooltip.id]);
  fireEvent.click(button);
  expect(click).toHaveBeenCalledOnce();
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("opens on hover, dismisses on Escape and requires leaving before reopening", () => {
  render(<HeaderTooltip label="Refresh"><button>Reload</button></HeaderTooltip>);
  const button = screen.getByRole("button");
  fireEvent.mouseEnter(button);
  expect(screen.getByRole("tooltip").textContent).toBe("Refresh");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.mouseLeave(button);
  fireEvent.mouseEnter(button);
  expect(screen.getByRole("tooltip")).toBeTruthy();
  fireEvent.mouseLeave(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("makes a disabled control description focusable without enabling the action", () => {
  render(<HeaderTooltip label="Unavailable: no connection" focusable><button disabled>Notifications</button></HeaderTooltip>);
  const wrapper = screen.getByLabelText("Unavailable: no connection");
  fireEvent.focus(wrapper);
  expect(wrapper.getAttribute("aria-describedby")).toBe(screen.getByRole("tooltip").id);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.blur(wrapper);
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("clamps tooltip placement to the viewport", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "tooltip" ? { width: 280 } as DOMRect : { left: 300, width: 20, bottom: 44 } as DOMRect;
  });
  render(<HeaderTooltip label="A description"><button>Control</button></HeaderTooltip>);
  fireEvent.focus(screen.getByRole("button"));
  expect(screen.getByRole("tooltip").style.left).toBe("32px");
  expect(screen.getByRole("tooltip").style.top).toBe("50px");
  rect.mockRestore();
});

it("suppresses touch focus but permits a later keyboard focus", () => {
  render(<HeaderTooltip label="Menu"><button>Open</button></HeaderTooltip>);
  const button = screen.getByRole("button");
  const pointer = new Event("pointerdown", { bubbles: true });
  Object.defineProperty(pointer, "pointerType", { value: "touch" });
  fireEvent(button, pointer);
  fireEvent.focus(button);
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.blur(button);
  fireEvent.keyDown(document, { key: "Tab" });
  fireEvent.focus(button);
  expect(screen.getByRole("tooltip").textContent).toBe("Menu");
});
