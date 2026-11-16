#!/usr/bin/env node
// Minimal scripted `gemini --acp`: the Agent Client Protocol over stdio as the Gemini CLI speaks it, with a few prompts
// that script what a turn does. Its sessions live in FAKE_GEMINI_HOME, so a new process can load them.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("0.0.0-fake\n");
  process.exit(0);
}
if (!process.argv.includes("--acp")) process.exit(2);

const home = process.env.FAKE_GEMINI_HOME;
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
  const id = `agent-${++nextRequest}`;
  pending.set(id, resolve);
  write({ id, method, params });
});

const MODES = ["default", "autoEdit", "yolo", "plan"].map((id) => ({ id, name: id }));
const MODELS = [
  { modelId: "auto", name: "Auto", description: "Routes each request." },
  { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { modelId: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview" },
];
const opened = (session) => ({ modes: { availableModes: MODES, currentModeId: session.mode }, models: { availableModels: MODELS, currentModelId: session.model } });
const OPTIONS = [
  { optionId: "proceed_always", name: "Allow for this session", kind: "allow_always" },
  { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
  { optionId: "cancel", name: "Reject", kind: "reject_once" },
];

/** A tool call that asks first (unless the mode lets it through), then runs. */
async function tool(session, call, result, auto) {
  const sessionId = session.id;
  if (auto) {
    update(sessionId, { sessionUpdate: "tool_call", ...call, status: "in_progress" });
  } else {
    update(sessionId, { sessionUpdate: "tool_call", ...call, status: "pending" });
    const answer = await ask("session/request_permission", { sessionId, options: OPTIONS, toolCall: { ...call, status: "pending" } });
    session.answers.push(answer.outcome);
    if (answer.outcome.outcome !== "selected" || answer.outcome.optionId === "cancel") {
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: "failed", kind: call.kind, content: [{ type: "content", content: text(`Tool "${call.title}" was canceled by the user.`) }] });
      return false;
    }
  }
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: call.toolCallId, status: "completed", title: call.title, kind: call.kind, content: result });
  return true;
}

async function prompt(session, blocks) {
  const sessionId = session.id;
  const texts = blocks.filter((block) => block.type === "text").map((block) => block.text);
  const said = texts.at(-1) ?? "";
  const all = texts.join("\n");
  const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, thoughtTokens: 1, totalTokens: 15 };
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
    const ran = await tool(session, { toolCallId: `shell-${randomUUID()}`, title: "echo hi", kind: "execute", content: [], locations: [] },
      [{ type: "content", content: text("hi") }], session.mode === "yolo");
    say(ran ? "ran it" : "not run");
    return done();
  }
  if (said === "edit file") {
    const diff = { type: "diff", path: join(session.cwd, "notes.txt"), oldText: "one\ntwo\nthree\n", newText: "one\n2\nthree\n", _meta: { kind: "modify" } };
    const edited = await tool(session, { toolCallId: `edit-${randomUUID()}`, title: "Edit notes.txt", kind: "edit", content: [diff], locations: [{ path: diff.path }] },
      [diff], session.mode === "yolo" || session.mode === "autoEdit");
    say(edited ? "edited" : "not edited");
    return done();
  }
  if (said === "read file") {
    await tool(session, { toolCallId: `read-${randomUUID()}`, title: "ReadFile notes.txt", kind: "read", content: [], locations: [{ path: "notes.txt" }] },
      [{ type: "content", content: text("one\ntwo") }], true);
    say("read it");
    return done();
  }
  if (said === "leave plan") {
    const left = await tool(session, { toolCallId: `plan-${randomUUID()}`, title: "Exit plan mode", kind: "switch_mode", content: [], locations: [] }, [], false);
    say(left ? "left plan mode" : "still planning");
    return done();
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: text("**Thinking**\nabout it") });
  // The CLI's own notice, which no chat shows.
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: text("[MODE_UPDATE] default") });
  say(`gemini[${session.model}/${session.mode}]: ${said}`);
  update(sessionId, { sessionUpdate: "usage_update", used: 1500, size: 1_000_000 });
  return done();
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
    agentInfo: { name: "gemini-cli", title: "Gemini CLI", version: "0.0.0-fake" },
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true } },
  }),
  "session/new": ({ cwd }) => {
    if (process.env.FAKE_GEMINI_AUTH === "none") throw Object.assign(new Error("Authentication required."), { code: -32000 });
    const session = { id: randomUUID(), cwd, mode: "default", model: "auto", prompts: [], answers: [] };
    sessions.set(session.id, session);
    return { sessionId: session.id, ...opened(session) };
  },
  "session/load": ({ sessionId, cwd }) => {
    const saved = stored()[sessionId];
    if (!saved || saved.cwd !== cwd) throw Object.assign(new Error(`Session not found: ${sessionId}`), { code: -32602 });
    const session = { id: sessionId, cwd, mode: "default", model: "auto", prompts: saved.prompts, answers: [] };
    sessions.set(sessionId, session);
    // Like the CLI: the session's history is replayed as updates before the answer.
    for (const said of saved.prompts) {
      update(sessionId, { sessionUpdate: "user_message_chunk", content: text(said) });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: text(`replayed: ${said}`) });
    }
    return opened(session);
  },
  "session/set_mode": ({ sessionId, modeId }) => {
    if (!MODES.some((mode) => mode.id === modeId)) throw Object.assign(new Error(`Invalid or unavailable mode: ${modeId}`), { code: -32603 });
    sessions.get(sessionId).mode = modeId;
    return {};
  },
  "session/set_model": ({ sessionId, modelId }) => {
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
    pending.get(message.id)?.(message.result ?? { outcome: { outcome: "cancelled" } });
    pending.delete(message.id);
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
