// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttentionPrompt } from "../../../bridge/src/attention-prompt-protocol";
import { AttentionAnswerForm, type AttentionAnswerSubmitResult } from "./AttentionAnswerForm";

const single: AttentionPrompt = {
  channel: "mail",
  questions: [{ question: "Which database?", header: "DB", options: [{ label: "Postgres", description: "Relational" }, { label: "SQLite" }], multiSelect: false, allowText: true }],
};
const multi: AttentionPrompt = { channel: "mail", questions: [{ question: "Which checks?", options: [{ label: "Lint" }, { label: "Tests" }, { label: "Types" }], multiSelect: true, allowText: false }] };
const freeText: AttentionPrompt = { channel: "mail", questions: [{ question: "What should the branch be called?", options: [], multiSelect: false, allowText: true }] };
const ok = async (): Promise<AttentionAnswerSubmitResult> => ({ ok: true, message: "Answer sent to worker." });

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

function renderForm(prompt: AttentionPrompt, extra: Partial<Parameters<typeof AttentionAnswerForm>[0]> = {}) {
  const onSubmit = vi.fn(ok);
  render(<AttentionAnswerForm prompt={prompt} sessionName="worker" onSubmit={onSubmit} {...extra} />);
  return onSubmit;
}
const sendButton = () => screen.getByRole("button", { name: /Send answer|Sending\.\.\./ }) as HTMLButtonElement;

it("renders a single-select question as radios with header, description and an optional note", () => {
  renderForm(single);
  expect(screen.getByText("DB")).toBeTruthy();
  expect(screen.getByText("Which database?")).toBeTruthy();
  expect(screen.getAllByRole("radio").length).toBe(2);
  expect(screen.getByLabelText(/Postgres/)).toBeTruthy();
  expect(screen.getByText("Relational")).toBeTruthy();
  expect(screen.getByLabelText("Other answer or note (optional)")).toBeTruthy();
  expect(screen.queryByText("The agent is waiting for this answer.")).toBeNull();
});

it("renders a multi-select question as checkboxes without a text box", () => {
  renderForm(multi);
  expect(screen.getAllByRole("checkbox").length).toBe(3);
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("renders a free-text-only question with a Your answer box and no options", () => {
  renderForm(freeText);
  expect(screen.queryAllByRole("radio").length).toBe(0);
  expect(screen.queryAllByRole("checkbox").length).toBe(0);
  expect(screen.getByLabelText("Your answer")).toBeTruthy();
});

it("keeps submit disabled until the answer is valid", () => {
  renderForm(single);
  expect(sendButton().disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/SQLite/));
  expect(sendButton().disabled).toBe(false);
});

it("enables a free-text question only once text is typed", () => {
  renderForm(freeText);
  expect(sendButton().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "feat/x" } });
  expect(sendButton().disabled).toBe(false);
});

it("submits normalized single-select answers with the note", async () => {
  const onSubmit = renderForm(single);
  fireEvent.click(screen.getByLabelText(/SQLite/));
  fireEvent.change(screen.getByLabelText("Other answer or note (optional)"), { target: { value: "thanks" } });
  fireEvent.click(sendButton());
  await screen.findByRole("status");
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(onSubmit).toHaveBeenCalledWith([{ selected: [1], text: "thanks" }]);
});

it("submits multi-select choices in ascending order", async () => {
  const onSubmit = renderForm(multi);
  fireEvent.click(screen.getByLabelText("Types"));
  fireEvent.click(screen.getByLabelText("Lint"));
  fireEvent.click(sendButton());
  await screen.findByRole("status");
  expect(onSubmit).toHaveBeenCalledWith([{ selected: [0, 2] }]);
});

it("shows Sending... while pending, ignores a second click, then reports success and locks the form", async () => {
  let finish!: (result: AttentionAnswerSubmitResult) => void;
  const onSubmit = vi.fn(() => new Promise<AttentionAnswerSubmitResult>(resolve => { finish = resolve; }));
  render(<AttentionAnswerForm prompt={multi} sessionName="worker" onSubmit={onSubmit} />);
  fireEvent.click(screen.getByLabelText("Lint"));
  fireEvent.click(sendButton());
  expect(sendButton().textContent).toBe("Sending...");
  expect(sendButton().disabled).toBe(true);
  fireEvent.click(sendButton());
  expect(onSubmit).toHaveBeenCalledTimes(1);
  await act(async () => finish({ ok: true, message: "Answer delivered to worker." }));
  expect(screen.getByRole("status").textContent).toBe("Answer delivered to worker.");
  expect((screen.getByLabelText("Lint") as HTMLInputElement).disabled).toBe(true);
  expect(sendButton().disabled).toBe(true);
});

it("shows an error result in an alert and keeps the user's choices", async () => {
  const onSubmit = vi.fn(async (): Promise<AttentionAnswerSubmitResult> => ({ ok: false, message: "This question was already answered or dismissed." }));
  render(<AttentionAnswerForm prompt={single} sessionName="worker" onSubmit={onSubmit} />);
  fireEvent.click(screen.getByLabelText(/Postgres/));
  fireEvent.change(screen.getByLabelText("Other answer or note (optional)"), { target: { value: "keep me" } });
  fireEvent.click(sendButton());
  expect((await screen.findByRole("alert")).textContent).toBe("This question was already answered or dismissed.");
  expect((screen.getByLabelText(/Postgres/) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("Other answer or note (optional)") as HTMLTextAreaElement).value).toBe("keep me");
  expect(sendButton().disabled).toBe(false);
  expect(screen.queryByRole("status")).toBeNull();
});

it("shows a thrown submit failure as an alert", async () => {
  const onSubmit = vi.fn(async (): Promise<AttentionAnswerSubmitResult> => { throw new Error("offline"); });
  render(<AttentionAnswerForm prompt={multi} sessionName="worker" onSubmit={onSubmit} />);
  fireEvent.click(screen.getByLabelText("Tests"));
  fireEvent.click(sendButton());
  expect((await screen.findByRole("alert")).textContent).toBe("offline");
});

it("disables every input and shows the reason when disabledReason is set", () => {
  renderForm(single, { disabledReason: "Bridge is offline." });
  expect(screen.getByText("Bridge is offline.")).toBeTruthy();
  for (const radio of screen.getAllByRole("radio")) expect((radio as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Other answer or note (optional)") as HTMLTextAreaElement).disabled).toBe(true);
  expect(sendButton().disabled).toBe(true);
});

it("shows the waiting helper and Answer in terminal for the hook channel only", () => {
  const onAnswerInTerminal = vi.fn();
  const hook: AttentionPrompt = { ...single, channel: "hook" };
  const view = render(<AttentionAnswerForm prompt={hook} sessionName="worker" onSubmit={ok} onAnswerInTerminal={onAnswerInTerminal} />);
  expect(screen.getByText("The agent is waiting for this answer.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Answer in terminal" }));
  expect(onAnswerInTerminal).toHaveBeenCalledTimes(1);
  view.unmount();
  render(<AttentionAnswerForm prompt={single} sessionName="worker" onSubmit={ok} onAnswerInTerminal={onAnswerInTerminal} />);
  expect(screen.queryByRole("button", { name: "Answer in terminal" })).toBeNull();
});

it("omits Answer in terminal for the hook channel without a handler", () => {
  renderForm({ ...single, channel: "hook" });
  expect(screen.getByText("The agent is waiting for this answer.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Answer in terminal" })).toBeNull();
});

it("handles multiple questions and needs all of them answered", async () => {
  const both: AttentionPrompt = { channel: "mail", questions: [single.questions[0], freeText.questions[0]] };
  const onSubmit = renderForm(both);
  expect(screen.getAllByRole("group").length).toBe(2);
  fireEvent.click(screen.getByLabelText(/Postgres/));
  expect(sendButton().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "main" } });
  expect(sendButton().disabled).toBe(false);
  fireEvent.click(sendButton());
  await screen.findByRole("status");
  expect(onSubmit).toHaveBeenCalledWith([{ selected: [0] }, { selected: [], text: "main" }]);
});

it("keeps Answer in terminal enabled when disabledReason is set", () => {
  const onAnswerInTerminal = vi.fn();
  renderForm({ ...single, channel: "hook" }, { disabledReason: "Bridge is offline.", onAnswerInTerminal });
  const button = screen.getByRole("button", { name: "Answer in terminal" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  expect(onAnswerInTerminal).toHaveBeenCalledTimes(1);
});

it("uses distinct radio names per question and per form instance", () => {
  const two: AttentionPrompt = { channel: "mail", questions: [single.questions[0], single.questions[0]] };
  render(<><AttentionAnswerForm prompt={two} sessionName="a" onSubmit={ok} /><AttentionAnswerForm prompt={single} sessionName="b" onSubmit={ok} /></>);
  const names = screen.getAllByRole("radio").map(radio => (radio as HTMLInputElement).name);
  expect(new Set(names).size).toBe(3);
});

it("does not crash when the prompt gains questions while mounted", () => {
  const view = render(<AttentionAnswerForm prompt={single} sessionName="worker" onSubmit={ok} />);
  const two: AttentionPrompt = { channel: "mail", questions: [single.questions[0], freeText.questions[0]] };
  view.rerender(<AttentionAnswerForm prompt={two} sessionName="worker" onSubmit={ok} />);
  fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "x" } });
  expect(screen.getAllByRole("group").length).toBe(2);
});
