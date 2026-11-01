"use client";

import { useId, useRef, useState } from "react";
import type { AttentionAnswerEntry, AttentionPrompt } from "../../../bridge/src/attention-prompt-protocol";
import { validateAttentionAnswer } from "../../../bridge/src/attention-prompt";

export type AttentionAnswerSubmitResult = { ok: true; message: string } | { ok: false; message: string };

export interface AttentionAnswerFormProps {
  prompt: AttentionPrompt;
  sessionName: string;
  disabledReason?: string;
  onSubmit: (answers: AttentionAnswerEntry[]) => Promise<AttentionAnswerSubmitResult>;
  onAnswerInTerminal?: () => void;
}

export function AttentionAnswerForm({ prompt, sessionName, disabledReason, onSubmit, onAnswerInTerminal }: AttentionAnswerFormProps) {
  const baseId = useId();
  const [entries, setEntries] = useState<AttentionAnswerEntry[]>(() => prompt.questions.map(() => ({ selected: [], text: "" })));
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const pendingRef = useRef(false);

  const entryAt = (index: number): AttentionAnswerEntry => entries[index] ?? { selected: [], text: "" };
  const current: AttentionAnswerEntry[] = prompt.questions.map((_, index) => {
    const entry = entryAt(index);
    return entry.text?.trim() ? { selected: entry.selected, text: entry.text } : { selected: entry.selected };
  });
  const checked = validateAttentionAnswer(prompt, current);
  const locked = pending || !!disabledReason || !!done;

  function update(index: number, change: (entry: AttentionAnswerEntry) => AttentionAnswerEntry) {
    setEntries(previous => prompt.questions.map((_, i) => (i === index ? change(previous[i] ?? { selected: [], text: "" }) : previous[i] ?? { selected: [], text: "" })));
    setError("");
  }
  function toggle(index: number, option: number, multi: boolean) {
    update(index, entry => {
      if (!multi) return { ...entry, selected: [option] };
      const selected = entry.selected.includes(option) ? entry.selected.filter(value => value !== option) : [...entry.selected, option].sort((a, b) => a - b);
      return { ...entry, selected };
    });
  }
  async function submit() {
    if (pendingRef.current || locked || !checked.ok) return;
    pendingRef.current = true;
    setPending(true);
    setError("");
    try {
      const result = await onSubmit(checked.value);
      if (result.ok) setDone(result.message);
      else setError(result.message);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not send the answer. Try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <form
      aria-label={`Answer ${sessionName}`}
      className="min-w-0 space-y-3"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      {prompt.channel === "hook" && <p className="text-xs text-[var(--text-muted)]">The agent is waiting for this answer.</p>}
      {prompt.questions.map((question, index) => {
        const multi = question.multiSelect;
        const hasOptions = question.options.length > 0;
        const groupId = `${baseId}-q${index}`;
        return (
          <fieldset key={index} disabled={locked} className="min-w-0 space-y-2 border-0 p-0">
            <legend className="mb-1 min-w-0 max-w-full">
              {question.header && <span className="block break-words text-xs text-[var(--text-muted)] [overflow-wrap:anywhere]">{question.header}</span>}
              <span className="block whitespace-pre-wrap break-words text-sm font-semibold [overflow-wrap:anywhere]">{question.question}</span>
            </legend>
            {question.options.map((option, optionIndex) => {
              const id = `${groupId}-o${optionIndex}`;
              return (
                <label
                  key={optionIndex}
                  htmlFor={id}
                  className="flex min-h-11 w-full min-w-0 cursor-pointer items-start gap-2 rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] p-2"
                >
                  <input
                    id={id}
                    type={multi ? "checkbox" : "radio"}
                    name={groupId}
                    className="mt-1 shrink-0"
                    disabled={locked}
                    checked={entryAt(index).selected.includes(optionIndex)}
                    onChange={() => toggle(index, optionIndex, multi)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm [overflow-wrap:anywhere]">{option.label}</span>
                    {option.description && <span className="block break-words text-xs text-[var(--text-muted)] [overflow-wrap:anywhere]">{option.description}</span>}
                  </span>
                </label>
              );
            })}
            {question.allowText && (
              <label htmlFor={`${groupId}-text`} className="flex min-w-0 flex-col gap-1 text-xs text-[var(--text-muted)]">
                {hasOptions ? "Other answer or note (optional)" : "Your answer"}
                <textarea
                  id={`${groupId}-text`}
                  className="min-h-20 w-full min-w-0 rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] p-2 text-sm text-[var(--text-primary)]"
                  value={entryAt(index).text ?? ""}
                  disabled={locked}
                  onChange={event => update(index, entry => ({ ...entry, text: event.target.value }))}
                />
              </label>
            )}
          </fieldset>
        );
      })}
      {disabledReason && <p className="text-xs text-[var(--text-muted)]">{disabledReason}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-accent min-h-11" disabled={locked || !checked.ok}>
          {pending ? "Sending..." : "Send answer"}
        </button>
        {prompt.channel === "hook" && onAnswerInTerminal && (
          <button type="button" className="btn-ghost min-h-11" disabled={pending || !!done} onClick={onAnswerInTerminal}>
            Answer in terminal
          </button>
        )}
      </div>
      {done && (
        <p role="status" className="break-words text-xs text-[var(--text-muted)] [overflow-wrap:anywhere]">
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-[var(--status-error)] [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </form>
  );
}
