// Antigravity chats through the gateway, black box: fake stock, fake Claude, and a scripted `agy acp` (a real child
// process speaking ACP over stdio).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, fakeQuery, fakeStartup } from "../fixtures/fakeClaude.js";
import { startTestGateway, type Client, type TestGateway } from "./harness.js";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ccodex-claude-"));
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "ccodex-codex-home-"));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...await importOriginal<object>(),
  query: fakeQuery,
  startup: fakeStartup,
}));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const FAKE_AGY = fileURLToPath(new URL("../fixtures/fakeAntigravity.mjs", import.meta.url));
const AGY = "antigravity:gemini-4-carbon";
const text = (value: string) => [{ type: "text", text: value, text_elements: [] }];
const itemsOf = (turns: any[]) => turns.flatMap((turn) => turn.items.map((item: any) => item.type === "userMessage"
  ? `user:${item.content[0]?.text}` : item.type === "agentMessage" ? `agent:${item.text}` : item.type));

let gateway: TestGateway;
let client: Client;
let cwd: string;
let agyHome: string;

async function antigravityThread(extra: Record<string, unknown> = {}): Promise<string> {
  const { thread } = await client.request("thread/start", { model: AGY, cwd, ...extra });
  return thread.id;
}

const history = async (threadId: string) => itemsOf((await client.request("thread/read", { threadId, includeTurns: true })).thread.turns);
const starts = () => readFileSync(join(agyHome, "starts.log"), "utf8").trim().split("\n").length;

describe("Antigravity chats (black box: fake stock + fake Antigravity CLI over ACP)", () => {
  beforeEach(async () => {
    fakeClaude.reset();
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "ccodex-agy-cwd-")));
    writeFileSync(join(cwd, "notes.txt"), "one\ntwo\nthree\n");
    agyHome = mkdtempSync(join(tmpdir(), "ccodex-agy-home-"));
    process.env.FAKE_AGY_HOME = agyHome;
    delete process.env.FAKE_AGY_AUTH;
    gateway = await startTestGateway({ antigravityBinary: FAKE_AGY });
    client = await gateway.connect();
  });
  afterEach(async () => { await gateway.stop(); });

  it("lists Antigravity's models beside the other providers', one per model with its efforts", async () => {
    // `agy models` answers a moment after the gateway starts.
    await vi.waitFor(async () => expect((await client.request("model/list", {})).data.map((model: any) => model.id)).toContain(AGY));
    const models = (await client.request("model/list", {})).data;
    expect(models.map((model: any) => model.id)).toEqual(expect.arrayContaining(["gpt-6-luna", "claude:claude-opus-5-5", AGY, "antigravity:gemini-3.8-flash", "antigravity:gemini-pro-orchestrator", "antigravity:claude-opus-5-5"]));
    expect(models.filter((model: any) => model.id.startsWith("antigravity:"))).toHaveLength(4);
    const carbon = models.find((model: any) => model.id === AGY);
    expect(carbon).toMatchObject({ displayName: "Gemini 4 Carbon", defaultReasoningEffort: "medium" });
    expect(carbon.supportedReasoningEfforts.map((effort: any) => effort.reasoningEffort)).toEqual(["low", "medium", "high"]);
    expect(models.find((model: any) => model.id === "antigravity:gemini-pro-orchestrator")).toMatchObject({ displayName: "Orchestrator (Carbon)", supportedReasoningEfforts: [] });
    // Another maker's model through Antigravity says so, apart from CCodex's own Claude.
    expect(models.find((model: any) => model.id === "antigravity:claude-opus-5-5")).toMatchObject({ displayName: "Claude Opus 5.5 (Antigravity)" });
  });

  it("runs the model at the effort picked for it", async () => {
    await vi.waitFor(async () => expect((await client.request("model/list", {})).data.map((model: any) => model.id)).toContain(AGY));
    const threadId = await antigravityThread({ effort: "high" });
    expect((await client.request("thread/read", { threadId })).thread).toMatchObject({ reasoningEffort: "high" });
    await client.turn(threadId, "hello");
    expect((await history(threadId)).at(-1)).toBe("agent:agy[gemini-4-carbon-high/default]: hello");
    await client.turn(threadId, "again", { effort: "low" });
    expect((await history(threadId)).at(-1)).toBe("agent:agy[gemini-4-carbon-low/default]: again");
    // A model without that effort runs at its default; one without efforts by its own id.
    await client.turn(threadId, "orchestrate", { model: "antigravity:gemini-pro-orchestrator" });
    expect((await history(threadId)).at(-1)).toBe("agent:agy[gemini-pro-orchestrator/default]: orchestrate");
    await client.turn(threadId, "flash", { model: "antigravity:claude-opus-5-5", effort: "medium" });
    expect((await history(threadId)).at(-1)).toBe("agent:agy[claude-opus-5-5-low/default]: flash");
  });

  it("runs a turn: thinking, the streamed answer, the context meter, and history", async () => {
    const threadId = await antigravityThread();
    await client.waitFor("thread/started", (params) => params.thread.id === threadId);
    const done = await client.turn(threadId, "hello");
    expect(done.turn.status).toBe("completed");
    const methods = client.messages.filter((message) => message.params?.threadId === threadId && message.id === undefined).map((message) => message.method);
    expect(methods.indexOf("turn/started")).toBeLessThan(methods.indexOf("item/started"));
    expect(methods).toEqual(expect.arrayContaining(["item/agentMessage/delta", "thread/tokenUsage/updated", "turn/completed"]));
    // No reasoning item: the App shows one only as a passing status line.
    expect(methods.filter((method) => method.startsWith("item/reasoning/"))).toEqual([]);
    // The answer streams in the chunks the CLI sent; the CLI's own mode notice is no part of it.
    const messages = client.notifications("item/completed", threadId).map((message) => message.params.item).filter((item) => item.type === "agentMessage");
    // The thought stays in the chat as commentary; the answer follows it.
    expect(messages.map((item) => [item.text, item.phase])).toEqual([["> **Thinking**\n> about it", "commentary"], ["agy[gemini-4-carbon-medium/default]: hello", "final_answer"]]);
    const deltas = client.notifications("item/agentMessage/delta", threadId).filter((message) => message.params.itemId === messages[1].id).map((message) => message.params.delta).join("");
    expect(deltas).toBe("agy[gemini-4-carbon-medium/default]: hello");
    expect(client.notifications("thread/tokenUsage/updated", threadId).at(-1)!.params.tokenUsage).toMatchObject({ modelContextWindow: 1_048_576, last: { totalTokens: 1500 } });
    expect(await history(threadId)).toEqual(["user:hello", "agent:> **Thinking**\n> about it", "agent:agy[gemini-4-carbon-medium/default]: hello"]);
    const { thread } = await client.request("thread/read", { threadId });
    expect(thread).toMatchObject({ modelProvider: "antigravity", model: AGY, preview: "hello", cwd, status: { type: "idle" } });
    const page = await client.request("thread/turns/list", { threadId, limit: 5 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0].items.map((item: any) => item.type)).toEqual(["userMessage", "agentMessage"]);
  });

  it("lists Antigravity chats with stock's, finds them by search, and leaves an empty one out", async () => {
    const empty = await antigravityThread();
    const threadId = await antigravityThread();
    await client.turn(threadId, "find the needle here");
    const stock = (await client.request("thread/start", { model: "gpt-6-luna", cwd })).thread.id;
    await client.turn(stock, "stock message");
    const ids = (await client.request("thread/list", { limit: 50 })).data.map((thread: any) => thread.id);
    expect(ids).toEqual(expect.arrayContaining([threadId, stock]));
    expect(ids).not.toContain(empty);
    expect((await client.request("thread/list", { limit: 50, modelProviders: ["antigravity"] })).data.map((thread: any) => thread.id)).toContain(threadId);
    const found = await client.request("thread/search", { searchTerm: "needle" });
    expect(found.data.map((result: any) => result.thread.id)).toEqual([threadId]);
    expect((await client.request("thread/loaded/list", {})).data).toContain(threadId);
  });

  it("asks the App before a command runs, and shows a declined one as declined", async () => {
    const threadId = await antigravityThread();
    const asked: any[] = [];
    client.onRequest = (message) => { asked.push(message); return { decision: "accept" }; };
    await client.turn(threadId, "run command");
    expect(asked.map((message) => message.method)).toEqual(["item/commandExecution/requestApproval"]);
    expect(asked[0].params).toMatchObject({ threadId, command: "echo hi", cwd });
    const command = client.notifications("item/completed", threadId).map((message) => message.params.item).find((item) => item.type === "commandExecution");
    expect(command).toMatchObject({ id: asked[0].params.itemId, command: "echo hi", status: "completed", aggregatedOutput: "hi\n", exitCode: 0 });
    // What the agent said before the command is commentary; after it, the answer.
    expect(client.notifications("item/completed", threadId).map((message) => message.params.item).filter((item) => item.type === "agentMessage").map((item) => [item.text, item.phase]))
      .toEqual([["I will run it.", "commentary"], ["ran it", "final_answer"]]);

    client.onRequest = () => ({ decision: "decline" });
    await client.turn(threadId, "run command");
    const declined = client.notifications("item/completed", threadId).map((message) => message.params.item).filter((item) => item.type === "commandExecution").at(-1);
    expect(declined).toMatchObject({ status: "declined" });
    expect((await history(threadId)).at(-1)).toBe("agent:not run");
  });

  it("shows a file change with its patch before asking, and the App's choice decides", async () => {
    const threadId = await antigravityThread();
    const asked: any[] = [];
    client.onRequest = (message) => { asked.push(message); return { decision: "acceptForSession" }; };
    await client.turn(threadId, "edit file");
    expect(asked.map((message) => message.method)).toEqual(["item/fileChange/requestApproval"]);
    const started = client.notifications("item/started", threadId).map((message) => message.params.item).find((item) => item.type === "fileChange");
    expect(started.changes).toEqual([]);
    // The CLI asks with only the replaced snippet: the App gets the patch where it lands in the file.
    const patched = client.notifications("item/fileChange/patchUpdated", threadId)[0]!.params;
    const patch = [{ path: join(cwd, "notes.txt"), kind: { type: "update", move_path: null }, diff: "@@ -1,3 +1,3 @@\n one\n-two\n+2\n three" }];
    expect(patched).toMatchObject({ itemId: asked[0].params.itemId, changes: patch });
    expect(client.messages.indexOf(client.notifications("item/fileChange/patchUpdated", threadId)[0]!)).toBeLessThan(client.messages.indexOf(asked[0]));
    expect(client.notifications("item/completed", threadId).map((message) => message.params.item).find((item) => item.type === "fileChange")).toMatchObject({ status: "completed", changes: patch });
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("one\n2\nthree\n");
  });

  it("shows a write over an existing file as the change it makes, not as a new file", async () => {
    const threadId = await antigravityThread();
    await client.turn(threadId, "write file");
    const change = client.notifications("item/completed", threadId).map((message) => message.params.item).find((item) => item.type === "fileChange");
    expect(change.changes).toEqual([{ path: join(cwd, "notes.txt"), kind: { type: "update", move_path: null }, diff: "@@ -1,3 +1,1 @@\n-one\n-two\n-three\n+fresh" }]);
  });

  it("leaves a command the agent moved to the background as run, not failed", async () => {
    const threadId = await antigravityThread();
    const done = await client.turn(threadId, "background command");
    expect(done.turn.status).toBe("completed");
    const command = client.notifications("item/completed", threadId).map((message) => message.params.item).find((item) => item.type === "commandExecution");
    expect(command).toMatchObject({ command: "sleep 30", status: "completed", exitCode: null });
  });

  it("maps the App's permissions to the CLI's approval modes", async () => {
    // Full Access: the CLI's auto mode, and what it still asks about is allowed unasked.
    const full = await antigravityThread({ approvalPolicy: "never", sandbox: "danger-full-access" });
    client.onRequest = () => { throw new Error("asked in Full Access"); };
    await client.turn(full, "hello");
    expect((await history(full)).at(-1)).toBe("agent:agy[gemini-4-carbon-medium/auto]: hello");
    await client.turn(full, "run command");
    expect((await history(full)).at(-1)).toBe("agent:ran it");
    // Never ask, without full access: what needs approval is declined unasked.
    const never = await antigravityThread({ approvalPolicy: "never" });
    await client.turn(never, "run command");
    expect((await history(never)).at(-1)).toBe("agent:not run");
    // Approve for me: the CLI's auto mode.
    const auto = await antigravityThread({ approvalsReviewer: "auto_review" });
    await client.turn(auto, "hello");
    expect((await history(auto)).at(-1)).toBe("agent:agy[gemini-4-carbon-medium/auto]: hello");
    await client.turn(auto, "edit file");
    expect((await history(auto)).at(-1)).toBe("agent:edited");
    // Plan mode: the CLI's plan mode.
    const plan = await antigravityThread({ collaborationMode: { mode: "plan", settings: { model: AGY } } });
    await client.turn(plan, "hello");
    expect((await history(plan)).at(-1)).toBe("agent:agy[gemini-4-carbon-medium/plan]: hello");
  });

  it("follows the chat's model and settings changes", async () => {
    const threadId = await antigravityThread();
    await client.turn(threadId, "hello");
    await client.request("thread/settings/update", { threadId, model: "antigravity:gemini-3.8-flash", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    expect(client.notifications("thread/settings/updated", threadId).at(-1)!.params.threadSettings).toMatchObject({ model: "antigravity:gemini-3.8-flash", approvalPolicy: "never" });
    await client.turn(threadId, "again");
    expect((await history(threadId)).at(-1)).toBe("agent:agy[gemini-3.8-flash-medium/auto]: again");
    const resumed = await client.request("thread/resume", { threadId });
    expect(resumed).toMatchObject({ model: "antigravity:gemini-3.8-flash", modelProvider: "antigravity", approvalPolicy: "never" });
    expect(resumed.thread.turns).toHaveLength(1);
  });

  it("stops a running turn", async () => {
    const threadId = await antigravityThread();
    await client.request("turn/start", { threadId, input: text("slow") });
    await client.waitFor("item/agentMessage/delta", (params) => params.threadId === threadId);
    expect((await client.request("thread/read", { threadId })).thread.status).toEqual({ type: "active", activeFlags: [] });
    await expect(client.request("turn/steer", { threadId, input: text("more") })).rejects.toThrow(/queue it/u);
    await client.request("turn/interrupt", { threadId });
    const done = await client.waitFor("turn/completed", (params) => params.threadId === threadId);
    expect(done.turn.status).toBe("interrupted");
    // The chat goes on in the same CLI session.
    await client.turn(threadId, "hello");
    expect((await history(threadId)).at(-1)).toBe("agent:agy[gemini-4-carbon-medium/default]: hello");
    expect(starts()).toBe(1);
  });

  it("stops a turn whose CLI never answers", async () => {
    const threadId = await antigravityThread();
    await client.request("turn/start", { threadId, input: text("stuck") });
    await client.waitFor("item/completed", (params) => params.threadId === threadId && params.item.type === "userMessage");
    await new Promise((resolve) => setTimeout(resolve, 300));
    client.request("turn/interrupt", { threadId });
    const done = await client.waitFor("turn/completed", (params) => params.threadId === threadId, 15_000);
    expect(done.turn.status).toBe("interrupted");
  });

  it("queues a message sent while a turn runs", async () => {
    const threadId = await antigravityThread();
    await client.request("turn/start", { threadId, input: text("slow") });
    await client.waitFor("item/agentMessage/delta", (params) => params.threadId === threadId);
    const { queuedSubmission } = await client.request("thread/queue/add", { threadId, input: text("queued"), clientUserMessageId: "c-1" });
    expect((await client.request("thread/queue/list", { threadId })).data).toEqual([queuedSubmission]);
    await client.request("turn/interrupt", { threadId });
    await client.waitFor("item/completed", (params) => params.threadId === threadId && params.item.text === "agy[gemini-4-carbon-medium/default]: queued");
    expect((await client.request("thread/queue/list", { threadId })).data).toEqual([]);
  });

  it("keeps a chat across a gateway restart, on the CLI session it had", async () => {
    const threadId = await antigravityThread();
    await client.turn(threadId, "first");
    await client.request("thread/name/set", { threadId, name: "Kept" });
    const dataDir = join(mkdtempSync(join(tmpdir(), "ccodex-agy-state-")), "state");
    // A second gateway over the first one's state.
    const log = join(gateway.config.dataDir, "antigravity", `${threadId}.jsonl`);
    expect(existsSync(log)).toBe(true);
    execFileSync("mkdir", ["-p", join(dataDir, "antigravity")]);
    execFileSync("cp", [log, join(dataDir, "antigravity", `${threadId}.jsonl`)]);
    await gateway.stop();
    gateway = await startTestGateway({ antigravityBinary: FAKE_AGY, dataDir });
    client = await gateway.connect();
    const listed = (await client.request("thread/list", { limit: 50 })).data.find((thread: any) => thread.id === threadId);
    expect(listed).toMatchObject({ name: "Kept", preview: "first", status: { type: "notLoaded" } });
    expect(await history(threadId)).toEqual(["user:first", "agent:> **Thinking**\n> about it", "agent:agy[gemini-4-carbon-medium/default]: first"]);
    await client.request("thread/resume", { threadId });
    await client.turn(threadId, "recall");
    // The CLI loaded its session: it remembers the first message itself, nothing was handed over, and what the load
    // replayed of the history is no part of the turn.
    expect((await history(threadId)).slice(3)).toEqual(["user:recall", "agent:recall: first; handoff: none"]);
  });

  it("brings the history along when the CLI no longer has the chat's session", async () => {
    const threadId = await antigravityThread();
    await client.turn(threadId, "first");
    // The CLI's sessions are gone (agy opens an empty session for an id it doesn't have, with no error).
    rmSync(join(agyHome, "sessions.json"));
    // A second gateway over the first one's state (stopping a test gateway removes its own).
    const dataDir = join(mkdtempSync(join(tmpdir(), "ccodex-agy-state-")), "state");
    execFileSync("mkdir", ["-p", join(dataDir, "antigravity")]);
    execFileSync("cp", [join(gateway.config.dataDir, "antigravity", `${threadId}.jsonl`), join(dataDir, "antigravity")]);
    await gateway.stop();
    gateway = await startTestGateway({ antigravityBinary: FAKE_AGY, dataDir });
    client = await gateway.connect();
    await client.turn(threadId, "recall");
    const recalled = (await history(threadId)).at(-1)!;
    expect(recalled).toContain("recall: ;");
    expect(recalled).toContain("User: first");
  });

  it("rolls back and edits: the next message opens a CLI session with the kept history", async () => {
    const threadId = await antigravityThread();
    await client.turn(threadId, "one");
    await client.turn(threadId, "two");
    const rolled = await client.request("thread/rollback", { threadId, numTurns: 1 });
    expect(itemsOf(rolled.thread.turns)).toEqual(["user:one", "agent:> **Thinking**\n> about it", "agent:agy[gemini-4-carbon-medium/default]: one"]);
    await client.turn(threadId, "recall");
    const recalled = (await history(threadId)).at(-1)!;
    expect(recalled).toContain("recall: ;");
    expect(recalled).toContain("User: one");
    expect(recalled).not.toContain("two");
    // An edited first message: the chat starts over.
    const first = (await client.request("thread/turns/list", { threadId, limit: 10, sortDirection: "asc" })).data[0].id;
    await client.request("thread/revert", { threadId, beforeTurnId: first });
    expect(client.notifications("thread/reverted", threadId)).toHaveLength(1);
    expect(await history(threadId)).toEqual([]);
    await client.turn(threadId, "recall");
    expect((await history(threadId)).at(-1)).toBe("agent:recall: ; handoff: none");
  });

  it("forks a chat with its history, and a side chat that is no chat of its own", async () => {
    const threadId = await antigravityThread();
    await client.turn(threadId, "one");
    await client.turn(threadId, "two");
    const firstTurn = (await client.request("thread/turns/list", { threadId, limit: 10, sortDirection: "asc" })).data[0].id;
    const fork = await client.request("thread/fork", { threadId, lastTurnId: firstTurn });
    expect(fork.thread).toMatchObject({ forkedFromId: threadId, modelProvider: "antigravity" });
    expect(itemsOf(fork.thread.turns)).toEqual(["user:one", "agent:> **Thinking**\n> about it", "agent:agy[gemini-4-carbon-medium/default]: one"]);
    await client.turn(fork.thread.id, "recall");
    expect((await history(fork.thread.id)).at(-1)).toContain("User: one");
    expect(await history(threadId)).toHaveLength(6);

    const side = await client.request("thread/fork", { threadId, ephemeral: true, excludeTurns: true });
    expect(side.thread).toMatchObject({ ephemeral: true, forkedFromId: threadId });
    await client.turn(side.thread.id, "recall");
    expect(await history(side.thread.id)).toEqual(["user:recall", expect.stringContaining("User: two")]);
    const ids = (await client.request("thread/list", { limit: 50 })).data.map((thread: any) => thread.id);
    expect(ids).toEqual(expect.arrayContaining([threadId, fork.thread.id]));
    expect(ids).not.toContain(side.thread.id);
    expect(readdirSync(join(gateway.config.dataDir, "antigravity"))).toHaveLength(2);
  });

  it("refuses to switch a chat to or from Antigravity", async () => {
    const threadId = await antigravityThread();
    await client.turn(threadId, "hello");
    await expect(client.request("turn/start", { threadId, model: "gpt-6-luna", input: text("switch") })).rejects.toThrow(/can't switch to or from Antigravity/u);
    await expect(client.request("thread/settings/update", { threadId, model: "claude:claude-opus-5-5" })).rejects.toThrow(/can't switch to or from Antigravity/u);
    const stock = (await client.request("thread/start", { model: "gpt-6-luna", cwd })).thread.id;
    await client.turn(stock, "first");
    await expect(client.request("turn/start", { threadId: stock, model: AGY, input: text("switch") })).rejects.toThrow(/can't switch to or from Antigravity/u);
    const claude = (await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd: "/work" })).thread.id;
    await client.turn(claude, "first");
    await expect(client.request("thread/settings/update", { threadId: claude, model: AGY })).rejects.toThrow(/can't switch to or from Antigravity/u);
    // Both chats go on as they were.
    await client.turn(threadId, "still here");
    expect((await history(threadId)).at(-1)).toBe("agent:agy[gemini-4-carbon-medium/default]: still here");
    expect((await client.turn(stock, "second")).turn.status).toBe("completed");
  });

  it("makes the App's new-chat draft an Antigravity chat under its own id once an Antigravity model is picked for it", async () => {
    // A draft stock opened, the model picked in the composer before the first message.
    const picked = (await client.request("thread/start", { model: "gpt-6-luna", cwd })).thread.id;
    await client.request("thread/settings/update", { threadId: picked, model: AGY });
    expect(client.notifications("thread/settings/updated", picked).at(-1)!.params.threadSettings).toMatchObject({ model: AGY, modelProvider: "antigravity", cwd });
    await client.turn(picked, "first");
    expect(await history(picked)).toEqual(["user:first", "agent:> **Thinking**\n> about it", "agent:agy[gemini-4-carbon-medium/default]: first"]);
    const row = (await client.request("thread/list", { limit: 50 })).data.filter((thread: any) => thread.id === picked);
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ modelProvider: "antigravity", preview: "first" });
    // The model sent with the first message alone.
    const sent = (await client.request("thread/start", { model: "gpt-6-luna", cwd })).thread.id;
    await client.turn(sent, "hello", { model: "antigravity:gemini-3.8-flash" });
    expect((await history(sent)).at(-1)).toBe("agent:agy[gemini-3.8-flash-medium/default]: hello");
    // A Claude draft.
    const claude = (await client.request("thread/start", { model: "claude:claude-opus-5-5", cwd })).thread.id;
    await client.turn(claude, "hello", { model: AGY });
    expect((await client.request("thread/read", { threadId: claude, includeTurns: true })).thread).toMatchObject({ modelProvider: "antigravity" });
    expect(fakeClaude.prompts).toEqual([]);
    await client.turn(claude, "/cc");
    expect(client.notifications("item/completed", claude).map((message) => message.params.item.text).at(-1)).toContain("✦ Gemini 4 Carbon");
  });

  it("gives a draft back when another model is picked before its first message", async () => {
    // Stock's draft: Antigravity picked, then GPT again.
    const stock = (await client.request("thread/start", { model: "gpt-6-luna", cwd })).thread.id;
    await client.request("thread/settings/update", { threadId: stock, model: AGY });
    await client.turn(stock, "first", { model: "gpt-6-luna" });
    expect(await history(stock)).toEqual(["user:first", "agent:gpt: first"]);
    expect((await client.request("thread/read", { threadId: stock })).thread.modelProvider).toBe("openai");
    // A draft born an Antigravity chat: Claude takes it under its id.
    const toClaude = await antigravityThread({ cwd: "/work" });
    await client.turn(toClaude, "first", { model: "claude:claude-opus-5-5" });
    expect((await client.request("thread/read", { threadId: toClaude, includeTurns: true })).thread).toMatchObject({ modelProvider: "claude" });
    expect(fakeClaude.prompts.map((prompt) => prompt.text)).toEqual(["first"]);
    // Its id is no stock thread's: it can't become a GPT chat, and stays the Antigravity draft it was.
    const stays = await antigravityThread();
    await expect(client.request("thread/settings/update", { threadId: stays, model: "gpt-6-luna" })).rejects.toThrow(/can't become a GPT chat/u);
    await client.turn(stays, "hello");
    expect((await history(stays)).at(-1)).toBe("agent:agy[gemini-4-carbon-medium/default]: hello");
  });

  it("renames, archives and deletes; a deleted chat's log goes to the trash", async () => {
    const threadId = await antigravityThread();
    await client.turn(threadId, "hello");
    await client.request("thread/name/set", { threadId, name: "Named" });
    expect(client.notifications("thread/name/updated", threadId).at(-1)!.params.threadName).toBe("Named");
    await client.request("thread/archive", { threadId });
    expect((await client.request("thread/list", { limit: 50 })).data.map((thread: any) => thread.id)).not.toContain(threadId);
    expect((await client.request("thread/list", { limit: 50, archived: true })).data.map((thread: any) => thread.id)).toContain(threadId);
    expect((await client.request("thread/unarchive", { threadId })).thread.name).toBe("Named");
    await client.request("thread/delete", { threadId });
    expect(client.notifications("thread/deleted", threadId)).toHaveLength(1);
    expect(existsSync(join(gateway.config.dataDir, "antigravity", `${threadId}.jsonl`))).toBe(false);
    const trash = readdirSync(join(gateway.config.dataDir, "trash"));
    expect(trash).toHaveLength(1);
    expect(readdirSync(join(gateway.config.dataDir, "trash", trash[0]!))).toEqual(expect.arrayContaining([`${threadId}.jsonl`, "meta.json"]));
    // Gone from every list (stock answers for an id that is no Antigravity chat any more).
    for (const archived of [false, true]) {
      expect((await client.request("thread/list", { limit: 50, archived })).data.map((thread: any) => thread.id)).not.toContain(threadId);
    }
  });

  it("names a new chat with the title model, marked as Antigravity's", async () => {
    await gateway.stop();
    gateway = await startTestGateway({ antigravityBinary: FAKE_AGY, renamePrompt: "Title it." });
    client = await gateway.connect();
    const threadId = await antigravityThread();
    await client.turn(threadId, "hello");
    const named = await client.waitFor("thread/name/updated", (params) => params.threadId === threadId);
    expect(named.threadName).toBe("🦊 Fox Title ✦");
  });

  it("fails the turn, in words, when the CLI fails, is not signed in, or dies", async () => {
    const threadId = await antigravityThread();
    const failed = await client.turn(threadId, "fail");
    expect(failed.turn).toMatchObject({ status: "failed", error: { message: "Antigravity: quota exhausted" } });
    expect(client.notifications("error", threadId)).toHaveLength(1);
    const crashed = await client.turn(threadId, "crash");
    expect(crashed.turn.status).toBe("failed");
    expect(crashed.turn.error.message).toMatch(/exited \(code 3\)/u);
    // The chat goes on in a new process, with what was said so far.
    await client.turn(threadId, "hello");
    expect((await history(threadId)).at(-1)).toBe("agent:agy[gemini-4-carbon-medium/default]: hello");

    process.env.FAKE_AGY_AUTH = "none";
    const signedOut = await antigravityThread();
    const refused = await client.turn(signedOut, "hello");
    expect(refused.turn.status).toBe("failed");
    expect(refused.turn.error.message).toMatch(/not signed in.*ccodex auth antigravity/u);
  });

  it("answers /cc for an Antigravity chat and leaves stock's limits out of it", async () => {
    const threadId = await antigravityThread();
    await client.turn(threadId, "hello");
    await client.turn(threadId, "/cc");
    const card = client.notifications("item/completed", threadId).map((message) => message.params.item).filter((item) => item.type === "agentMessage").at(-1);
    expect(card.text).toContain("✦ Gemini 4 Carbon");
    expect(card.text).toContain("Context");
    // The status card is no part of the chat.
    expect(await history(threadId)).toHaveLength(3);
    expect(await client.request("account/rateLimits/read", {})).toMatchObject({ rateLimits: { limitId: "antigravity", primary: null } });
  });

  it("puts on the wire only what the installed codex's schema allows", async () => {
    const out = mkdtempSync(join(tmpdir(), "ccodex-schema-"));
    execFileSync(fileURLToPath(new URL("../../node_modules/.bin/codex", import.meta.url)), ["app-server", "generate-json-schema", "--out", out], { stdio: "ignore" });
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    ajv.addSchema(JSON.parse(readFileSync(join(out, "codex_app_server_protocol.v2.schemas.json"), "utf8")), "v2");
    ajv.addSchema(JSON.parse(readFileSync(join(out, "ServerRequest.json"), "utf8")), "server-request");
    const errors: string[] = [];
    const validate = (definition: string, value: unknown, context: string) => {
      const check = ajv.getSchema(definition === "ServerRequest" ? "server-request" : `v2#/definitions/${definition}`);
      if (!check) errors.push(`${context}: no ${definition} in the schema`);
      else if (!check(value)) errors.push(`${context} ✗ ${definition}: ${ajv.errorsText(check.errors, { separator: "; " }).slice(0, 600)}`);
    };
    const call = async (method: string, params: unknown, definition?: string) => {
      const result = await client.request(method, params);
      if (definition) validate(definition, result, method);
      return result;
    };
    const started = await call("thread/start", { model: AGY, cwd }, "ThreadStartResponse");
    const threadId: string = started.thread.id;
    validate("TurnStartResponse", await client.request("turn/start", { threadId, input: text("hello") }), "turn/start");
    await client.waitFor("turn/completed", (params) => params.threadId === threadId);
    client.onRequest = () => ({ decision: "accept" });
    await client.turn(threadId, "run command");
    await client.turn(threadId, "edit file");
    await client.turn(threadId, "read file");
    await client.turn(threadId, "fail");
    await call("thread/read", { threadId, includeTurns: true }, "ThreadReadResponse");
    await call("thread/resume", { threadId }, "ThreadResumeResponse");
    await call("thread/turns/list", { threadId, limit: 10 }, "ThreadTurnsListResponse");
    await call("thread/items/list", { threadId, limit: 10 }, "ThreadItemsListResponse");
    await call("thread/list", { limit: 20 }, "ThreadListResponse");
    for (const model of (await call("model/list", {})).data.filter((entry: any) => entry.id.startsWith("antigravity:"))) validate("Model", model, `model ${model.id}`);
    await call("account/rateLimits/read", {}, "GetAccountRateLimitsResponse");
    await call("thread/settings/update", { threadId, model: "antigravity:gemini-3.8-flash" });
    await call("thread/goal/get", { threadId }, "ThreadGoalGetResponse");
    validate("QueuedSubmission", (await call("thread/queue/add", { threadId, input: text("queued"), clientUserMessageId: "c-1" })).queuedSubmission, "thread/queue/add");
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && client.notifications("item/completed", threadId).some((m) => m.params.item.text?.endsWith(": queued")));
    const side = await call("thread/fork", { threadId, ephemeral: true, excludeTurns: true }, "ThreadForkResponse");
    await client.turn(side.thread.id, "side question");
    const fork = await call("thread/fork", { threadId }, "ThreadForkResponse");
    await call("thread/name/set", { threadId: fork.thread.id, name: "Forked" }, "ThreadSetNameResponse");
    await call("thread/archive", { threadId: fork.thread.id }, "ThreadArchiveResponse");
    await call("thread/unarchive", { threadId: fork.thread.id }, "ThreadUnarchiveResponse");
    await call("thread/unsubscribe", { threadId: side.thread.id }, "ThreadUnsubscribeResponse");
    const newest = (await client.request("thread/turns/list", { threadId, limit: 1 })).data[0].id;
    await call("thread/revert", { threadId, beforeTurnId: newest }, "ThreadRevertResponse");
    await call("turn/interrupt", { threadId }, "TurnInterruptResponse");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const ids = new Set([threadId, side.thread.id, fork.thread.id]);
    const ours = client.messages.filter((message) => message.method !== undefined && (ids.has(message.params?.threadId) || ids.has(message.params?.thread?.id)));
    for (const message of ours) {
      validate(message.id === undefined ? "ServerNotification" : "ServerRequest", message.id === undefined ? { method: message.method, params: message.params } : message, message.method);
    }
    expect(ours.length).toBeGreaterThan(40);
    expect(errors).toEqual([]);
  });
});
