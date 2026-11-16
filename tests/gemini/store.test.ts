import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Turn } from "../../src/protocol/codex.js";
import { appendEvents, foldThread, handoff, parseEvents, previewOf, readThread, readThreads, searchThreads, threadPath, type ThreadEvent } from "../../src/gemini/store.js";

const turn = (id: string, said: string, answer: string): Turn => ({
  id, itemsView: "full", status: "completed", error: null, startedAt: 10, completedAt: 11, durationMs: 1_000,
  items: [
    { type: "userMessage", id: `${id}:user`, clientId: null, content: [{ type: "text", text: said, text_elements: [] }] },
    { type: "agentMessage", id: `${id}:m0`, text: answer, phase: "final_answer", memoryCitation: null },
  ],
});
const created: ThreadEvent = { type: "created", at: 1, cwd: "/work", model: "auto", permissionMode: "default", plan: false };

describe("a Gemini chat folded from its log", () => {
  it("is what its events say, in order", () => {
    const record = foldThread("t", [
      created,
      { type: "turn", at: 11, turn: turn("a", "first question", "first answer"), total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 }, context: { used: 100, size: 1000 } },
      { type: "session", at: 11, sessionId: "s1" },
      { type: "named", at: 12, name: "Named" },
      { type: "settings", at: 13, model: "gemini-2.5-pro", plan: true },
      { type: "turn", at: 21, turn: turn("b", "second", "answer two") },
    ])!;
    expect(record).toMatchObject({ id: "t", cwd: "/work", model: "gemini-2.5-pro", plan: true, permissionMode: "default", name: "Named", sessionId: "s1", createdAt: 1, updatedAt: 21 });
    expect(record.turns.map((entry) => entry.id)).toEqual(["a", "b"]);
    // A turn without its own usage keeps the chat's.
    expect(record.total.totalTokens).toBe(15);
    expect(record.context).toEqual({ used: 100, size: 1000 });
    expect(previewOf(record)).toBe("first question");
  });

  it("cuts history and forgets the CLI session that held it", () => {
    const record = foldThread("t", [
      created, { type: "turn", at: 11, turn: turn("a", "one", "1") }, { type: "turn", at: 12, turn: turn("b", "two", "2") }, { type: "session", at: 12, sessionId: "s1" },
      { type: "truncated", at: 13, turns: 1 }, { type: "session", at: 13, sessionId: null },
    ])!;
    expect(record.turns.map((entry) => entry.id)).toEqual(["a"]);
    expect(record.sessionId).toBeNull();
  });

  it("is no chat before its first event, and passes over a line a crash cut short", () => {
    expect(foldThread("t", [{ type: "named", at: 1, name: "orphan" }])).toBeUndefined();
    const events = parseEvents(`${JSON.stringify(created)}\n\n{"type":"named","at":2,"name":"ok"}\n{"type":"turn","at":3,"tu`);
    expect(events.map((event) => event.type)).toEqual(["created", "named"]);
  });

  it("reads back from disk what was appended", () => {
    const directory = join(mkdtempSync(join(tmpdir(), "ccodex-gemini-store-")), "gemini");
    appendEvents(directory, "t", [created]);
    appendEvents(directory, "t", [{ type: "turn", at: 11, turn: turn("a", "hello", "hi") }]);
    appendEvents(directory, "t", []);
    expect(readFileSync(threadPath(directory, "t"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(readThread(directory, "t")!.turns).toHaveLength(1);
    expect(readThread(directory, "missing")).toBeUndefined();
    writeFileSync(join(directory, "broken.jsonl"), "not json\n");
    expect(readThreads(directory).map((record) => record.id)).toEqual(["t"]);
    expect(readThreads(join(directory, "none"))).toEqual([]);
  });

  it("finds chats by what was said in them", () => {
    const one = foldThread("one", [created, { type: "turn", at: 11, turn: turn("a", "where is the Needle hidden", "in the haystack") }])!;
    const two = foldThread("two", [created, { type: "named", at: 2, name: "Needlework" }])!;
    const three = foldThread("three", [created, { type: "turn", at: 11, turn: turn("a", "nothing", "here") }])!;
    const found = searchThreads([one, two, three], "needle");
    expect([...found.keys()]).toEqual(["one", "two"]);
    expect(found.get("one")).toContain("Needle hidden");
    expect(searchThreads([one], "").size).toBe(0);
  });
});

describe("the chat so far, for a CLI session that has none of it", () => {
  it("is nothing for a chat without history", () => {
    expect(handoff([])).toBe("");
  });

  it("is the transcript, oldest first, with commands and file changes", () => {
    const withTools: Turn = {
      ...turn("b", "fix it", "fixed"),
      items: [
        { type: "userMessage", id: "b:user", clientId: null, content: [{ type: "text", text: "fix it", text_elements: [] }] },
        { type: "commandExecution", id: "c", command: "npm test", cwd: "/work", processId: null, source: "agent", status: "completed", commandActions: [], aggregatedOutput: "1 failed", exitCode: 1, durationMs: 5 },
        { type: "fileChange", id: "f", status: "completed", changes: [{ path: "/work/a.ts", kind: { type: "update", move_path: null }, diff: "" }] },
        { type: "reasoning", id: "r", summary: ["hidden"], content: [] },
        { type: "agentMessage", id: "b:m0", text: "fixed", phase: "final_answer", memoryCitation: null },
      ],
    };
    const text = handoff([turn("a", "hello", "hi there"), withTools]);
    expect(text).toContain("<earlier_conversation>");
    expect(text.indexOf("User:\nhello")).toBeLessThan(text.indexOf("User:\nfix it"));
    expect(text).toContain("Assistant ran `npm test` (completed):\n1 failed");
    expect(text).toContain("Assistant changed /work/a.ts");
    expect(text).not.toContain("hidden");
    expect(text.trimEnd().endsWith("The user's next message:")).toBe(true);
  });

  it("keeps the newest turns when the chat is longer than fits, and says how many it left out", () => {
    const long = Array.from({ length: 40 }, (_, index) => turn(`t${index}`, `question ${index}`, "x".repeat(5_000)));
    const text = handoff(long);
    expect(text.length).toBeLessThan(70_000);
    expect(text).toContain("question 39");
    expect(text).not.toContain("question 0\n");
    expect(text).toMatch(/\(\d+ earlier turns left out\)/u);
  });
});
