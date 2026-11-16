import { describe, expect, it } from "vitest";
import { addUsage, applyUpdate, closeTurn, commandOutput, declineTool, NO_USAGE, openTurn, promptUsage, turnRecord, userMessage, type Notification, type TurnState } from "../../src/antigravity/turn.js";

const text = (value: string) => ({ type: "text", text: value });
const fresh = () => openTurn({ threadId: "t", turnId: "turn", cwd: "/work", startedAtMs: 1_000 });

/** Folds the updates in order; the notifications of all of them. */
function fold(state: TurnState, updates: object[], atMs = 2_000): { state: TurnState; out: Notification[] } {
  return updates.reduce<{ state: TurnState; out: Notification[] }>((done, update) => {
    const next = applyUpdate(done.state, update, atMs);
    return { state: next.state, out: [...done.out, ...next.out] };
  }, { state, out: [] });
}

const methods = (out: readonly Notification[]) => out.map((notification) => notification.method);

describe("an Antigravity turn folded from ACP session updates", () => {
  it("streams one agent message from its chunks and leaves the turn it folded untouched", () => {
    const start = fresh();
    const { state, out } = fold(start, [
      { sessionUpdate: "agent_message_chunk", content: text("Hel") },
      { sessionUpdate: "agent_message_chunk", content: text("lo") },
    ]);
    expect(methods(out)).toEqual(["item/started", "item/agentMessage/delta", "item/agentMessage/delta"]);
    expect(out[0]!.params.item).toMatchObject({ type: "agentMessage", id: "turn:m0", text: "" });
    expect(state.items).toEqual([{ type: "agentMessage", id: "turn:m0", text: "Hello", phase: null, memoryCitation: null }]);
    expect(start.items).toEqual([]);
  });

  it("drops the CLI's own mode notice", () => {
    const { state, out } = fold(fresh(), [{ sessionUpdate: "agent_message_chunk", content: text("[MODE_UPDATE] yolo") }]);
    expect(out).toEqual([]);
    expect(state.items).toEqual([]);
  });

  it("shows each thought as a part of one reasoning item, which ends when the answer starts", () => {
    const { state, out } = fold(fresh(), [
      { sessionUpdate: "agent_thought_chunk", content: text("**A**\nfirst") },
      { sessionUpdate: "agent_thought_chunk", content: text("**B**\nsecond") },
      { sessionUpdate: "agent_message_chunk", content: text("answer") },
    ]);
    expect(methods(out)).toEqual([
      "item/started", "item/reasoning/summaryPartAdded", "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded", "item/reasoning/summaryTextDelta",
      "item/completed", "item/started", "item/agentMessage/delta",
    ]);
    expect(out[3]!.params).toMatchObject({ itemId: "turn:r0", summaryIndex: 1 });
    expect(out[5]!.params.item).toEqual({ type: "reasoning", id: "turn:r0", summary: ["**A**\nfirst", "**B**\nsecond"], content: [] });
    expect(state.reasoning).toBeNull();
    expect(state.message).toBe("turn:m1");
  });

  it("ends what was said before a tool call as commentary, and the last message as the answer", () => {
    const run = fold(fresh(), [
      { sessionUpdate: "agent_message_chunk", content: text("Let me check.") },
      { sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress", title: "ls -la", kind: "execute", content: [] },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: text("a\nb") }] },
      { sessionUpdate: "agent_message_chunk", content: text("Two files.") },
    ], 2_500);
    const closed = closeTurn(run.state, "completed", 3_000);
    const done = [...run.out, ...closed.out].filter((notification) => notification.method === "item/completed").map((notification) => notification.params.item);
    expect(done.map((item: any) => [item.type, item.phase ?? item.status])).toEqual([["agentMessage", "commentary"], ["commandExecution", "completed"], ["agentMessage", "final_answer"]]);
    expect(done[1]).toMatchObject({ id: "c1", command: "ls -la", cwd: "/work", aggregatedOutput: "a\nb", exitCode: 0, commandActions: [{ type: "unknown", command: "ls -la" }] });
    expect(turnRecord(closed.state, "completed", null, 3_000)).toMatchObject({ id: "turn", status: "completed", startedAt: 1, completedAt: 3, durationMs: 2_000, error: null });
  });

  it("maps a tool call by its kind: a read, a search, a file change, or a tool of the agent's", () => {
    const { state } = fold(fresh(), [
      { sessionUpdate: "tool_call", toolCallId: "r", status: "in_progress", title: "ReadFile a.ts", kind: "read", locations: [{ path: "src/a.ts" }] },
      { sessionUpdate: "tool_call", toolCallId: "s", status: "in_progress", title: "Search 'x'", kind: "search", locations: [] },
      { sessionUpdate: "tool_call", toolCallId: "w", status: "in_progress", title: "Searching the web", kind: "fetch", rawInput: { query: "x" } },
      { sessionUpdate: "tool_call", toolCallId: "e", status: "pending", title: "Write new.txt", kind: "edit", content: [{ type: "diff", path: "new.txt", oldText: null, newText: "hi\n" }] },
    ]);
    expect(state.items.map((item) => item.type)).toEqual(["commandExecution", "commandExecution", "dynamicToolCall", "fileChange"]);
    expect(state.items[0]).toMatchObject({ command: "Read src/a.ts", commandActions: [{ type: "read", name: "a.ts", path: "/work/src/a.ts" }] });
    expect(state.items[1]).toMatchObject({ commandActions: [{ type: "search", query: null, path: null }] });
    expect(state.items[2]).toMatchObject({ namespace: "antigravity", tool: "Searching the web", arguments: { query: "x" } });
    expect(state.items[3]).toMatchObject({ changes: [{ path: "/work/new.txt", kind: { type: "add" }, diff: "hi\n" }], status: "inProgress" });
  });

  it("tells a file change's patch once the CLI knows it", () => {
    const { state, out } = fold(fresh(), [
      { sessionUpdate: "tool_call", toolCallId: "e", status: "pending", title: "Edit a.txt", kind: "edit", content: [] },
      { sessionUpdate: "tool_call_update", toolCallId: "e", status: "pending", content: [{ type: "diff", path: "/work/a.txt", oldText: "a\n", newText: "b\n" }] },
    ]);
    expect(methods(out)).toEqual(["item/started", "item/fileChange/patchUpdated"]);
    expect(state.items[0]).toMatchObject({ changes: [{ kind: { type: "update", move_path: null }, diff: "@@ -1,1 +1,1 @@\n-a\n+b" }] });
  });

  it("shows a call the user declined as declined, a tool's own failure as failed", () => {
    const calls = fold(fresh(), [
      { sessionUpdate: "tool_call", toolCallId: "no", status: "pending", title: "rm -rf x", kind: "execute" },
      { sessionUpdate: "tool_call", toolCallId: "bad", status: "in_progress", title: "false", kind: "execute" },
    ]);
    const { state } = fold(declineTool(calls.state, "no"), [
      { sessionUpdate: "tool_call_update", toolCallId: "no", status: "failed", content: [{ type: "content", content: text("canceled by the user") }] },
      { sessionUpdate: "tool_call_update", toolCallId: "bad", status: "failed", content: [{ type: "content", content: text("exit 1") }] },
    ]);
    expect(state.items.map((item: any) => [item.status, item.exitCode])).toEqual([["declined", 1], ["failed", 1]]);
    expect(state.tools).toEqual({});
  });

  it("starts and ends at once a call the CLI tells only when it is over", () => {
    const { out } = fold(fresh(), [{ sessionUpdate: "tool_call", toolCallId: "c", status: "completed", title: "pwd", kind: "execute", content: [{ type: "content", content: text("/work") }] }]);
    expect(methods(out)).toEqual(["item/started", "item/completed"]);
    expect(out[1]!.params.item).toMatchObject({ status: "completed", aggregatedOutput: "/work" });
  });

  it("ends an interrupted turn's open tool calls with it, and its last message without the answer's phase", () => {
    const run = fold(fresh(), [
      { sessionUpdate: "tool_call", toolCallId: "c", status: "in_progress", title: "sleep 100", kind: "execute" },
      { sessionUpdate: "tool_call", toolCallId: "w", status: "in_progress", title: "web", kind: "fetch" },
      { sessionUpdate: "agent_message_chunk", content: text("partial") },
    ]);
    const closed = closeTurn(run.state, "interrupted", 3_000);
    expect(closed.state.items.map((item: any) => item.status ?? item.phase)).toEqual(["declined", "failed", null]);
    // A completed turn's open command was moved to the background: it ran, with no exit code yet.
    const completed = closeTurn(run.state, "completed", 3_000);
    expect(completed.state.items[0]).toMatchObject({ status: "completed", exitCode: null, aggregatedOutput: "(still running in the background when the turn ended)" });
    expect(closed.state.tools).toEqual({});
    expect(turnRecord(closed.state, "interrupted", null, 3_000).error).toBeNull();
    expect(turnRecord(closed.state, "failed", "boom", 3_000).error).toEqual({ message: "boom", codexErrorInfo: null, additionalDetails: null });
  });

  it("reports the plan and the context meter", () => {
    const { state, out } = fold(fresh(), [
      { sessionUpdate: "plan", entries: [{ content: "read", status: "completed" }, { content: "write", status: "in_progress" }, { content: "test", status: "pending" }] },
      { sessionUpdate: "usage_update", used: 2_000, size: 1_000_000 },
      { sessionUpdate: "available_commands_update", availableCommands: [] },
    ]);
    expect(out[0]).toEqual({ method: "turn/plan/updated", params: { threadId: "t", turnId: "turn", explanation: null, plan: [{ step: "read", status: "completed" }, { step: "write", status: "inProgress" }, { step: "test", status: "pending" }] } });
    expect(out[1]!.params.tokenUsage).toMatchObject({ modelContextWindow: 1_000_000, last: { totalTokens: 2_000, inputTokens: 2_000 }, total: NO_USAGE });
    expect(out).toHaveLength(2);
    expect(state.context).toEqual({ used: 2_000, size: 1_000_000 });
  });

  it("opens the turn's items with the user's message", () => {
    const { state, out } = userMessage(fresh(), [{ type: "text", text: "hi", text_elements: [] }], "client-1", 1_500);
    expect(methods(out)).toEqual(["item/started", "item/completed"]);
    expect(state.items).toEqual([{ type: "userMessage", id: "turn:user", clientId: "client-1", content: [{ type: "text", text: "hi", text_elements: [] }] }]);
  });

  it("counts a prompt's tokens as Codex does", () => {
    const usage = promptUsage({ inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, thoughtTokens: 1, totalTokens: 15 });
    expect(usage).toEqual({ totalTokens: 15, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1 });
    expect(promptUsage(undefined)).toEqual(NO_USAGE);
    expect(addUsage(usage, usage).totalTokens).toBe(30);
  });

  it("reads a command's output and exit code from Antigravity's report of it", () => {
    const report = "Created At: 2026-11-15T22:01:17-05:00\nCompleted At: 2026-11-15T22:01:17-05:00\nCommand exited with code 2.\n\nCommand output:\nhi\r\nthere\r\n";
    expect(commandOutput(report, undefined)).toEqual({ output: "hi\nthere\n", exitCode: 2 });
    expect(commandOutput(report, 0)).toEqual({ output: "hi\nthere\n", exitCode: 0 });
    expect(commandOutput("plain output", undefined)).toEqual({ output: "plain output", exitCode: null });
    const { state } = fold(fresh(), [
      { sessionUpdate: "tool_call", toolCallId: "c", status: "in_progress", title: "echo hi", kind: "execute" },
      { sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed", rawOutput: { output: report, exit_code: 0 }, content: [{ type: "content", content: text(report) }] },
    ]);
    expect(state.items[0]).toMatchObject({ status: "completed", aggregatedOutput: "hi\nthere\n", exitCode: 0 });
  });
});
