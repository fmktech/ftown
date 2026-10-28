import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectParentMailQuality } from "./ai-demo";

const home = "/home/user/demo-home";
const execution = (command: string, output: string, exitCode = 0) => ({
  type: "event_msg", payload: { type: "item_completed", item: {
    type: "CommandExecution", id: "exec-1", command: ["/bin/bash", "-lc", command],
    cwd: "file:///home/user/demo-workspace", status: exitCode === 0 ? "completed" : "failed", exit_code: exitCode, aggregated_output: output,
  } },
});
const read = '"$HOME/.ftown/ftown" harness mail read';

test("accepts genuine successful read with actual mail", () => {
  assert.deepEqual(inspectParentMailQuality([execution(read, "[ftown mail] actual result\n")], home),
    { completedExecutions: 1, successfulMailReads: 1, emptyReads: 0, colorConflicts: 0 });
});

test("rejects successful empty read, including ANSI styling", () => {
  assert.throws(() => inspectParentMailQuality([execution(read, "\u001b[33m(no mail)\u001b[0m\r\n")], home), /empty mail read/);
});

test("rejects actual completed tool output with the Node color conflict", () => {
  assert.throws(() => inspectParentMailQuality([execution("node -e check", "Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.\n", 1)], home), /color conflict/);
});

test("ignores quoted commands, unrelated output and failed reads", () => {
  const records = [execution("printf '%s' 'ftown harness mail read'", "(no mail)\n"), execution(read, "(no mail)\n", 1),
    { type: "response_item", payload: { type: "message", text: "(no mail)" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "unrelated", output: "(no mail)" } }];
  assert.deepEqual(inspectParentMailQuality(records, home), { completedExecutions: 2, successfulMailReads: 0, emptyReads: 0, colorConflicts: 0 });
});

test("accepts terminal failed commands without classifying their output as a successful read", () => {
  assert.deepEqual(inspectParentMailQuality([execution("git status", "fatal: not a git repository\n", 128), execution(read, "(no mail)\n", 1)], home),
    { completedExecutions: 2, successfulMailReads: 0, emptyReads: 0, colorConflicts: 0 });
});

test("requires complete and attributable native execution evidence", () => {
  assert.throws(() => inspectParentMailQuality([], home), /evidence missing/);
  assert.throws(() => inspectParentMailQuality([null], home), /Invalid parent rollout record/);
  for (const invalid of [
    { id: "", status: "completed" }, { id: "x", status: "in_progress" },
    { status: "unknown" }, { status: "completed", exit_code: 1 }, { status: "failed", exit_code: 0 },
    { status: "failed", exit_code: null }, { status: "completed", exit_code: undefined }, { status: "failed", exit_code: 1.5 },
    { id: "x", cwd: "file://other/home/user/demo-workspace" }, { id: "x", command: ["/bin/sh", "-c", read] },
    { id: "x", aggregated_output: null },
  ]) {
    const record = execution(read, "mail");
    Object.assign(record.payload.item, invalid);
    assert.throws(() => inspectParentMailQuality([record], home), /Unsupported completed parent execution/);
  }
});

test("legacy-only evidence fails closed and an uninspectable legacy read is rejected", () => {
  const legacy = { type: "response_item", payload: { type: "function_call", call_id: "call-1", arguments: JSON.stringify({ command: read }) } };
  const result = { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "mail" } };
  assert.throws(() => inspectParentMailQuality([legacy, result], home), /Unsupported legacy parent mail read evidence/);
  assert.throws(() => inspectParentMailQuality([result], home), /evidence missing/);
  assert.throws(() => inspectParentMailQuality([execution("pwd", "ok"), legacy, result], home), /Unsupported legacy parent mail read evidence/);
});

test("rejects empty output when a later heredoc makes the compound command uninspectable", () => {
  const command = `${read}; cat <<EOF\nok\nEOF`;
  assert.throws(() => inspectParentMailQuality([execution(command, "\u001b[33m(no mail)\u001b[0m\nok\n")], home), /Uninspectable parent empty output/);
});

test("accepts unsupported heredoc syntax with no empty output line", () => {
  assert.deepEqual(inspectParentMailQuality([execution("cat <<EOF\nok\nEOF", "ok\n")], home),
    { completedExecutions: 1, successfulMailReads: 0, emptyReads: 0, colorConflicts: 0 });
});

test("accepts an exact empty-looking line from a supported quoted non-mail command", () => {
  assert.deepEqual(inspectParentMailQuality([execution("printf '%s\\n' '(no mail)'", "(no mail)\n")], home),
    { completedExecutions: 1, successfulMailReads: 0, emptyReads: 0, colorConflicts: 0 });
});
