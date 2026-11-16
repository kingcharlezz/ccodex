#!/usr/bin/env node
// Minimal scripted `agy acp`: the Agent Client Protocol over stdio as the Antigravity CLI speaks it (probed against agy
// 1.5.9), with a few prompts that script what a turn does. Its sessions live in FAKE_AGY_HOME, so a new process can
// load them.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const MODELS = [
  ["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"], ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"], ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"], ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"], ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-pro-orchestrator", "Orchestrator (Carbon)"],
  ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"], ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
].map(([modelId, name]) => ({ modelId, name }));

if (process.argv.includes("--version")) {
  process.stdout.write("0.0.0-fake\n");
  process.exit(0);
}
if (process.argv[2] === "models") {
  process.stdout.write(`Fetching available models...\n${MODELS.map((model) => `${model.modelId}\t${model.name}`).join("\n")}\n`);
  process.exit(0);
}
if (process.argv[2] !== "acp") process.exit(2);

const home = process.env.FAKE_AGY_HOME;
const sessionsFile = home ? join(home, "sessions.json") : undefined;
const stored = () => sessionsFile && existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")) : {};
const store = (id, session) => {
  if (!sessionsFile) return;
  mkdirSync(home, { recursive: true });
  writeFileSync(sessionsFile, JSON.stringify({ ...stored(), [id]: { prompts: session.prompts, cwd: session.cwd } }));
};
/** Every process start, for tests that count them. */
if (home) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "starts.log"), `${process.pid}\n`, { flag: "a" });
}

const sessions = new Map();
const pending = new Map();
let nextRequest = 0;

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => write({ method: "session/update", params: { sessionId, update: body } });
const text = (value) => ({ type: "text", text: value });
/** A request to the client (a permission prompt). */
const ask = (method, params) => new Promise((resolve) => {
  const id = String(++nextRequest);
  pending.set(id, resolve);
  write({ id, method, params });
});

const MODES = ["default", "accept-edits", "auto", "plan"].map((id) => ({ id, name: id }));
const opened = (session) => ({ sessionId: session.id, modes: { availableModes: MODES, currentModeId: session.mode }, models: { availableModels: MODELS, currentModelId: session.model } });
const OPTIONS = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }];

/**
 * Like agy: a call is told in progress, then pending while it asks (the request alone carries an edit's patch, as the
 * replaced snippet), then in progress and completed, or failed when denied. `auto` asks about nothing here.
 */
async function tool(session, call, ask_content, result, apply) {
  const sessionId = session.id;
  update(sessionId, { sessionUpdate: "tool_call", ...call, status: "in_progress" });
  if (session.mode !== "auto" && !(session.mode === "accept-edits" && call.kind === "edit")) {
    update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "pending" });
    const answer = await ask("session/request_permission", { sessionId, options: OPTIONS, toolCall: { sessionUpdate: "tool_call", ...call, status: "pending", ...ask_content ? { content: ask_content } : {} } });
    session.answers.push(answer.outcome);
    if (answer.outcome.outcome !== "selected" || answer.outcome.optionId !== "allow") {
      update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "failed", rawOutput: { output: "" }, content: [{ type: "content", content: text("") }] });
      return false;
    }
    update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "in_progress" });
  }
  const content = apply();
  update(sessionId, { sessionUpdate: "tool_call_update", ...call, status: "completed", ...result, ...content ? { content } : {} });
  return true;
}

async function prompt(session, blocks) {
  const sessionId = session.id;
  const texts = blocks.filter((block) => block.type === "text").map((block) => block.text);
  const said = texts.at(-1) ?? "";
  const all = texts.join("\n");
  const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, cachedWriteTokens: 0, thoughtTokens: 1, totalTokens: 15 };
  update(sessionId, { sessionUpdate: "usage_update", used: 0, size: 1_048_576 });
  update(sessionId, { sessionUpdate: "user_message_chunk", content: text(said) });
  const done = (stopReason = "end_turn") => {
    session.prompts.push(said);
    store(sessionId, session);
    return { stopReason, usage };
  };
  const say = (value) => {
    const half = Math.ceil(value.length / 2);
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(value.slice(0, half)) });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(value.slice(half)) });
  };
  if (said === "crash") process.exit(3);
  if (said === "fail") throw Object.assign(new Error("quota exhausted"), { code: -32603 });
  if (said === "slow") {
    say("working");
    await new Promise((resolve) => { session.cancel = resolve; });
    return { stopReason: "cancelled" };
  }
  if (said === "stuck") {
    await new Promise(() => undefined);
  }
  if (said === "recall") {
    say(`recall: ${session.prompts.join(" | ")}; handoff: ${all.includes("<earlier_conversation>") ? all.slice(all.indexOf("<earlier_conversation>"), all.indexOf("</earlier_conversation>")).replace(/\s+/gu, " ") : "none"}`);
    return done();
  }
  if (said === "context") {
    say(`context: ${texts.slice(0, -1).join(" || ")}`);
    return done();
  }
  if (said === "run command") {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("I will run it.") });
    const output = `Created At: 2026-11-15T22:01:17-05:00\nCompleted At: 2026-11-15T22:01:17-05:00\nCommand exited with code 0.\n\nCommand output:\nhi\r\n`;
    const ran = await tool(session, { toolCallId: `call_${randomUUID()}`, name: "run_command", kind: "execute", title: "echo hi", rawInput: { CommandLine: "echo hi" } },
      undefined, { rawOutput: { output, exit_code: 0 }, content: [{ type: "content", content: text(output) }] }, () => undefined);
    say(ran ? "ran it" : "not run");
    return done();
  }
  if (said === "background command") {
    // agy moves a long command to the background: its call is still open when the turn ends.
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: `call_${randomUUID()}`, name: "run_command", kind: "execute", title: "sleep 30", status: "in_progress", rawInput: { CommandLine: "sleep 30" } });
    say("started it in the background");
    return done();
  }
  if (said === "edit file") {
    const path = join(session.cwd, "notes.txt");
    const before = readFileSync(path, "utf8");
    const edited = await tool(session, { toolCallId: `call_${randomUUID()}`, name: "edit_file", kind: "edit", title: "File notes.txt", locations: [{ path }], rawInput: { Path: path, Target: "two", Replacement: "2" } },
      [{ type: "diff", path, oldText: "two", newText: "2" }], { rawOutput: {} }, () => {
        const after = before.replace("two", "2");
        writeFileSync(path, after);
        return [{ type: "diff", path, oldText: before, newText: after }];
      });
    say(edited ? "edited" : "not edited");
    return done();
  }
  if (said === "write file") {
    const path = join(session.cwd, "notes.txt");
    await tool(session, { toolCallId: `call_${randomUUID()}`, name: "write_file", kind: "edit", title: "File notes.txt", rawInput: { Path: path, Content: "fresh\n" } },
      [{ type: "diff", path, newText: "fresh\n" }], { rawOutput: {} }, () => {
        writeFileSync(path, "fresh\n");
        return [{ type: "diff", path, newText: "fresh\n" }];
      });
    say("written");
    return done();
  }
  if (said === "read file") {
    await tool(session, { toolCallId: `call_${randomUUID()}`, name: "read_file", kind: "read", title: "File notes.txt", locations: [{ path: join(session.cwd, "notes.txt") }], rawInput: { Path: join(session.cwd, "notes.txt") } },
      undefined, {}, () => undefined);
    say("read it");
    return done();
  }
  update(sessionId, { sessionUpdate: "session_info_update", title: "A Title Of Its Own" });
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: text("**Thinking**\nabout it") });
  say(`agy[${session.model}/${session.mode}]: ${said}`);
  update(sessionId, { sessionUpdate: "usage_update", used: 1500, size: 1_048_576 });
  return done();
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true } },
    agentInfo: { name: "Antigravity ACP Server", version: "0.0.0-fake" },
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
  }),
  "session/new": ({ cwd }) => {
    if (process.env.FAKE_AGY_AUTH === "none") throw Object.assign(new Error("Authentication required."), { code: -32000 });
    const session = { id: randomUUID(), cwd, mode: "default", model: "gemini-4-carbon-medium", prompts: [], answers: [] };
    sessions.set(session.id, session);
    return opened(session);
  },
  // Like agy: an id it doesn't have opens an empty session, no error; one it has replays its history first.
  "session/load": ({ sessionId, cwd }) => {
    const saved = stored()[sessionId];
    const session = { id: sessionId, cwd, mode: "default", model: "gemini-4-carbon-medium", prompts: saved && saved.cwd === cwd ? saved.prompts : [], answers: [] };
    sessions.set(sessionId, session);
    for (const said of session.prompts) {
      update(sessionId, { sessionUpdate: "user_message_chunk", content: text(said) });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(`replayed: ${said}`) });
    }
    return opened(session);
  },
  "session/set_mode": ({ sessionId, modeId }) => {
    if (!MODES.some((mode) => mode.id === modeId)) throw Object.assign(new Error(`invalid mode: ${modeId}`), { code: -32602 });
    sessions.get(sessionId).mode = modeId;
    update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: modeId });
    return {};
  },
  "session/set_model": ({ sessionId, modelId }) => {
    if (!MODELS.some((model) => model.modelId === modelId)) throw Object.assign(new Error(`unknown model: ${modelId}`), { code: -32602 });
    sessions.get(sessionId).model = modelId;
    return {};
  },
  "session/prompt": ({ sessionId, prompt: blocks }) => {
    const session = sessions.get(sessionId);
    if (!session) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: -32602 });
    return prompt(session, blocks);
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    pending.get(String(message.id))?.(message.result ?? { outcome: { outcome: "cancelled" } });
    pending.delete(String(message.id));
    return;
  }
  if (message.id === undefined) {
    if (message.method === "session/cancel") sessions.get(message.params.sessionId)?.cancel?.();
    return;
  }
  Promise.resolve().then(() => {
    const handler = handlers[message.method];
    if (!handler) throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    return handler(message.params ?? {});
  }).then(
    (result) => write({ id: message.id, result }),
    (error) => write({ id: message.id, error: { code: error.code ?? -32603, message: error.message } }),
  );
});
