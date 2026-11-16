// A running Antigravity turn as the App sees it: each ACP `session/update` folds into the turn's items and yields the Codex
// notifications that show it. All pure: a step takes the turn so far and returns the next one with what to send.
import { basename, isAbsolute, resolve } from "node:path";
import type { CommandAction, FileUpdateChange, JsonObject, ThreadItem, TokenUsageBreakdown, Turn, TurnStatus, UserInput } from "../protocol/codex.js";
import { unifiedDiff } from "./diff.js";

export interface Notification {
  readonly method: string;
  readonly params: JsonObject;
}

export interface TurnState {
  readonly threadId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly startedAtMs: number;
  /** The turn's items in order: finished ones, and the open ones as they stand. */
  readonly items: readonly ThreadItem[];
  /** The agent message and the thought still streaming (their item ids). */
  readonly message: string | null;
  readonly thought: string | null;
  /** Tool calls in progress: when each started. */
  readonly tools: Readonly<Record<string, number>>;
  /** Tool calls the user (or the chat's never-ask setting) declined: their failure is no error of the tool's. */
  readonly declined: readonly string[];
  /** How many messages and thoughts the turn opened (their ids count up). */
  readonly opened: number;
  /** Context in use and the model's window, as the CLI last told them. */
  readonly context: { readonly used: number; readonly size: number } | null;
}

export interface Step {
  readonly state: TurnState;
  readonly out: readonly Notification[];
}

export function openTurn(turn: { threadId: string; turnId: string; cwd: string; startedAtMs: number }): TurnState {
  return { ...turn, items: [], message: null, thought: null, tools: {}, declined: [], opened: 0, context: null };
}

const step = (state: TurnState, ...out: Notification[]): Step => ({ state, out });

/** One step after another: the notifications in order, the last state. */
function chain(state: TurnState, ...steps: Array<(state: TurnState) => Step>): Step {
  return steps.reduce<Step>((done, next) => {
    const result = next(done.state);
    return { state: result.state, out: [...done.out, ...result.out] };
  }, step(state));
}

const started = (state: TurnState, item: ThreadItem, atMs: number): Notification =>
  ({ method: "item/started", params: { item, threadId: state.threadId, turnId: state.turnId, startedAtMs: atMs } });
const completed = (state: TurnState, item: ThreadItem, atMs: number): Notification =>
  ({ method: "item/completed", params: { item, threadId: state.threadId, turnId: state.turnId, completedAtMs: atMs } });

const withItem = (state: TurnState, item: ThreadItem): TurnState => ({
  ...state,
  items: state.items.some((candidate) => candidate.id === item.id)
    ? state.items.map((candidate) => candidate.id === item.id ? item : candidate)
    : [...state.items, item],
});

const itemOf = (state: TurnState, id: string | null): ThreadItem | undefined => id === null ? undefined : state.items.find((item) => item.id === id);

/** The user's message opens the turn's items (a hidden one, CCodex's own prompt, shows nothing). */
export function userMessage(state: TurnState, input: readonly UserInput[], clientId: string | null, atMs: number): Step {
  const item: ThreadItem = { type: "userMessage", id: `${state.turnId}:user`, clientId, content: [...input] };
  return step(withItem(state, item), started(state, item, atMs), completed(state, item, atMs));
}

// ---- streaming text and thoughts ----

/** The message so far ends (more work follows it: commentary; the turn's answer: final). */
function closeMessage(state: TurnState, phase: string | null, atMs: number): Step {
  const item = itemOf(state, state.message);
  if (item?.type !== "agentMessage") return step({ ...state, message: null });
  const done: ThreadItem = { ...item, phase };
  return step({ ...withItem(state, done), message: null }, completed(state, done, atMs));
}

/** The thought so far ends: it stays in the chat as commentary, never as the turn's answer. */
function closeThought(state: TurnState, atMs: number): Step {
  const item = itemOf(state, state.thought);
  if (item?.type !== "agentMessage") return step({ ...state, thought: null });
  return step({ ...state, thought: null }, completed(state, item, atMs));
}

/** What still streams ends before something else starts: the items keep the order things happened in. */
const settle = (atMs: number) => (state: TurnState): Step =>
  chain(state, (current) => closeMessage(current, "commentary", atMs), (current) => closeThought(current, atMs));

/** The CLI's own notice of an approval mode change, sent as if the model said it. */
const MODE_NOTICE = /^\[MODE_UPDATE\] /u;

function messageChunk(state: TurnState, text: string, atMs: number): Step {
  if (!text || MODE_NOTICE.test(text)) return step(state);
  const open = itemOf(state, state.message);
  if (open?.type === "agentMessage") {
    const item: ThreadItem = { ...open, text: `${open.text}${text}` };
    return step(withItem(state, item), { method: "item/agentMessage/delta", params: { threadId: state.threadId, turnId: state.turnId, itemId: item.id, delta: text } });
  }
  return chain(state, (current) => closeThought(current, atMs), (current) => {
    const id = `${current.turnId}:m${current.opened}`;
    const item: ThreadItem = { type: "agentMessage", id, text, phase: null, memoryCitation: null };
    return step(
      { ...withItem(current, item), message: id, opened: current.opened + 1 },
      started(current, { ...item, text: "" }, atMs),
      { method: "item/agentMessage/delta", params: { threadId: current.threadId, turnId: current.turnId, itemId: id, delta: text } },
    );
  });
}

/**
 * A thought of the model's, shown as commentary: a message that stays in the chat while the work it leads to runs.
 * The Antigravity CLI sends a thought whole, just before the tool call it leads to, and its models write no other
 * text between their tool calls. As a reasoning item the App would show it as a status line for that instant only,
 * and the chat would read as a row of commands.
 */
function thoughtChunk(state: TurnState, text: string, atMs: number): Step {
  if (!text.trim()) return step(state);
  const delta = (current: TurnState, item: ThreadItem & { type: "agentMessage" }, added: string): Step => step(
    withItem(current, { ...item, text: `${item.text}${added}` }),
    { method: "item/agentMessage/delta", params: { threadId: current.threadId, turnId: current.turnId, itemId: item.id, delta: added } },
  );
  // Quoted, so it reads as the model's thinking and not as what it tells the user.
  const quoted = text.trim().split(/\r?\n/u).map((line) => line ? `> ${line}` : ">").join("\n");
  const open = itemOf(state, state.thought);
  // One thought after another: paragraphs of the same quote.
  if (open?.type === "agentMessage") return delta(state, open, `\n>\n${quoted}`);
  return chain(state, (current) => closeMessage(current, "commentary", atMs), (current) => {
    const item = { type: "agentMessage" as const, id: `${current.turnId}:t${current.opened}`, text: "", phase: "commentary", memoryCitation: null };
    const opened = step({ ...withItem(current, item), thought: item.id, opened: current.opened + 1 }, started(current, item, atMs));
    const added = delta(opened.state, item, quoted);
    return { state: added.state, out: [...opened.out, ...added.out] };
  });
}

// ---- tool calls ----

/** A shell command as the App's actions: what it reads, lists or searches (the App shows those as such, not as a command). */
export type ParseCommand = (command: string, cwd: string) => CommandAction[];

/** No parser: the command as it is. */
export const unparsed: ParseCommand = (command) => [{ type: "unknown", command }];

interface ToolCall {
  readonly toolCallId: string;
  readonly status?: string | null;
  readonly title?: string | null;
  readonly kind?: string | null;
  readonly content?: readonly JsonObject[] | null;
  readonly locations?: ReadonlyArray<{ path?: string }> | null;
  readonly rawInput?: unknown;
  readonly rawOutput?: { readonly output?: unknown; readonly exit_code?: unknown } | null;
}

/**
 * A command's output and exit code. The Antigravity CLI reports a command as a header (`Created At: …`, `Command exited
 * with code N.`) before `Command output:`; the App shows only what the command wrote.
 */
export function commandOutput(text: string, exitCode: unknown): { readonly output: string; readonly exitCode: number | null } {
  const marker = text.indexOf("Command output:\n");
  const output = (marker >= 0 ? text.slice(marker + "Command output:\n".length) : text).replace(/\r\n/gu, "\n");
  const said = /Command exited with code (-?\d+)/u.exec(marker >= 0 ? text.slice(0, marker) : "");
  return { output, exitCode: typeof exitCode === "number" ? exitCode : said ? Number(said[1]) : null };
}

const absolute = (path: string, cwd: string) => isAbsolute(path) ? path : resolve(cwd, path);

/** The text a tool call shows (its output, or what the CLI says about it). */
function contentText(content: ToolCall["content"]): string {
  return (content ?? []).flatMap((entry) => entry.type === "content" && entry.content?.type === "text" ? [String(entry.content.text)] : []).join("\n");
}

/** The file changes a tool call proposes or made: its `diff` content. */
function fileChanges(content: ToolCall["content"], cwd: string): FileUpdateChange[] {
  return (content ?? []).flatMap((entry): FileUpdateChange[] => {
    if (entry.type !== "diff" || typeof entry.path !== "string") return [];
    const before = typeof entry.oldText === "string" ? entry.oldText : "";
    const after = typeof entry.newText === "string" ? entry.newText : "";
    const kind: string = entry._meta?.kind ?? (!before ? "add" : after === "" ? "delete" : "modify");
    const path = absolute(entry.path, cwd);
    if (kind === "add") return [{ path, kind: { type: "add" }, diff: after }];
    if (kind === "delete") return [{ path, kind: { type: "delete" }, diff: before }];
    return [{ path, kind: { type: "update", move_path: null }, diff: unifiedDiff(before, after) }];
  });
}

const FILE_KINDS = new Set(["edit", "delete", "move"]);

/** A tool call as the item the App has for its kind: a command, a file change, or a tool call of the agent's. */
function toolItem(call: ToolCall, cwd: string, parse: ParseCommand): ThreadItem {
  const title = call.title?.trim() || call.kind || "tool";
  const changes = fileChanges(call.content, cwd);
  if (changes.length || FILE_KINDS.has(call.kind ?? "")) return { type: "fileChange", id: call.toolCallId, changes, status: "inProgress" };
  const command = (text: string, commandActions: CommandAction[]): ThreadItem => ({
    type: "commandExecution", id: call.toolCallId, pluginId: null, scriptPath: null, command: text, cwd, processId: null, source: "agent",
    status: "inProgress", commandActions, aggregatedOutput: null, exitCode: null, durationMs: null,
  });
  const location = call.locations?.find((entry) => entry.path)?.path;
  if (call.kind === "execute") {
    // The command line itself, where the CLI tells it (the title may be a summary of it).
    const line = typeof (call.rawInput as JsonObject | undefined)?.CommandLine === "string" ? String((call.rawInput as JsonObject).CommandLine) : title;
    const actions = parse(line, cwd);
    return command(line, actions.length ? actions : unparsed(line, cwd));
  }
  if (call.kind === "read" && location) {
    const path = absolute(location, cwd);
    return command(`Read ${location}`, [{ type: "read", command: `Read ${location}`, name: basename(path) || path, path }]);
  }
  if (call.kind === "search") return command(title, [{ type: "search", command: title, query: null, path: location ? absolute(location, cwd) : null }]);
  return {
    type: "dynamicToolCall", id: call.toolCallId, namespace: "antigravity", tool: title,
    arguments: call.rawInput && typeof call.rawInput === "object" ? call.rawInput : {}, status: "inProgress", contentItems: null, success: null, durationMs: null,
  };
}

/** The item once its tool call ended (`failed`: also a call the user declined). */
function endedTool(item: ThreadItem, call: ToolCall, cwd: string, declined: boolean, durationMs: number): ThreadItem {
  const failed = call.status === "failed";
  const output = contentText(call.content);
  if (item.type === "commandExecution") {
    const ran = commandOutput(output || (typeof call.rawOutput?.output === "string" ? call.rawOutput.output : ""), call.rawOutput?.exit_code);
    return { ...item, status: declined ? "declined" : failed ? "failed" : "completed", aggregatedOutput: ran.output, exitCode: ran.exitCode ?? (failed ? 1 : 0), durationMs };
  }
  if (item.type === "fileChange") {
    // The patch shown with the approval stays: once applied, a write no longer tells what it replaced.
    const changes = item.changes.length ? item.changes : fileChanges(call.content, cwd);
    return { ...item, changes, status: declined ? "declined" : failed ? "failed" : "completed" };
  }
  if (item.type === "dynamicToolCall") {
    return { ...item, status: failed ? "failed" : "completed", success: !failed, durationMs, contentItems: output ? [{ type: "inputText", text: output }] : [] };
  }
  return item;
}

const ENDED = new Set(["completed", "failed"]);

/** A tool call starts (`tool_call`) or goes on (`tool_call_update`: its fields as far as they changed). */
function toolCall(state: TurnState, call: ToolCall, atMs: number, parse: ParseCommand): Step {
  const existing = itemOf(state, call.toolCallId);
  const ended = ENDED.has(call.status ?? "");
  if (!existing) {
    return chain(state, settle(atMs), (current) => {
      const item = toolItem(call, current.cwd, parse);
      const begun = step({ ...withItem(current, item), tools: { ...current.tools, [call.toolCallId]: atMs } }, started(current, item, atMs));
      // A call the CLI tells only once it is over (it needed no approval and took no time).
      if (!ended) return begun;
      const over = toolCall(begun.state, call, atMs, parse);
      return { state: over.state, out: [...begun.out, ...over.out] };
    });
  }
  if (ended) {
    const { [call.toolCallId]: startedAt, ...tools } = state.tools;
    const item = endedTool(existing, call, state.cwd, state.declined.includes(call.toolCallId), Math.max(0, atMs - (startedAt ?? atMs)));
    return step({ ...withItem(state, item), tools }, completed(state, item, atMs));
  }
  // Still running: only a file change's patch, once the CLI knows it, is news (the App shows the approval with it).
  if (existing.type === "fileChange" && !existing.changes.length) {
    const changes = fileChanges(call.content, state.cwd);
    if (changes.length) {
      return step(withItem(state, { ...existing, changes }),
        { method: "item/fileChange/patchUpdated", params: { threadId: state.threadId, turnId: state.turnId, itemId: existing.id, changes } });
    }
  }
  return step(state);
}

/** The call the user (or the chat's never-ask setting) declined: when the CLI reports it failed, it shows as declined. */
export function declineTool(state: TurnState, toolCallId: string): TurnState {
  return { ...state, declined: [...state.declined, toolCallId] };
}

// ---- plan and usage ----

const PLAN_STATUS: Record<string, string> = { pending: "pending", in_progress: "inProgress", completed: "completed" };

function planUpdate(state: TurnState, entries: ReadonlyArray<{ content?: string; status?: string }>): Step {
  const plan = entries.map((entry) => ({ step: String(entry.content ?? ""), status: PLAN_STATUS[entry.status ?? ""] ?? "pending" }));
  return step(state, { method: "turn/plan/updated", params: { threadId: state.threadId, turnId: state.turnId, explanation: null, plan } });
}

export const NO_USAGE: TokenUsageBreakdown = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };

/** ACP's usage of a prompt (`session/prompt`'s result) as Codex counts tokens. */
export function promptUsage(usage: JsonObject | null | undefined): TokenUsageBreakdown {
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  return {
    totalTokens: count(usage?.totalTokens) || input + output, inputTokens: input, cachedInputTokens: count(usage?.cachedReadTokens),
    cacheWriteInputTokens: count(usage?.cachedWriteTokens), outputTokens: output, reasoningOutputTokens: count(usage?.thoughtTokens),
  };
}

export const addUsage = (left: TokenUsageBreakdown, right: TokenUsageBreakdown): TokenUsageBreakdown => ({
  totalTokens: left.totalTokens + right.totalTokens, inputTokens: left.inputTokens + right.inputTokens,
  cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens, cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
  outputTokens: left.outputTokens + right.outputTokens, reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
});

/** The App's context meter: what the chat's last request held of the model's window. */
export function usageNotification(threadId: string, turnId: string | null, context: { used: number; size: number }, total: TokenUsageBreakdown): Notification {
  const last: TokenUsageBreakdown = { ...NO_USAGE, totalTokens: context.used, inputTokens: context.used };
  return { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total, last, modelContextWindow: context.size } } };
}

// ---- the fold ----

/** One `session/update` of the turn's session. `total`: the chat's tokens before this turn. */
export function applyUpdate(state: TurnState, update: JsonObject, atMs: number, total: TokenUsageBreakdown = NO_USAGE, parse: ParseCommand = unparsed): Step {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content?.type === "text" ? messageChunk(state, String(update.content.text ?? ""), atMs) : step(state);
    case "agent_thought_chunk":
      return update.content?.type === "text" ? thoughtChunk(state, String(update.content.text ?? ""), atMs) : step(state);
    case "tool_call":
    case "tool_call_update":
      return typeof update.toolCallId === "string" ? toolCall(state, update as unknown as ToolCall, atMs, parse) : step(state);
    case "plan":
      return Array.isArray(update.entries) ? planUpdate(state, update.entries) : step(state);
    case "usage_update": {
      if (typeof update.used !== "number" || typeof update.size !== "number") return step(state);
      const context = { used: update.used, size: update.size };
      return step({ ...state, context }, usageNotification(state.threadId, state.turnId, context, total));
    }
    default:
      return step(state);
  }
}

/**
 * The turn ends: what still streams completes (the last message as the answer of a turn that completed), and the tool
 * calls still open end with it. A command still open when the turn completed was moved to the background by the agent
 * (it does so with a long one): it shows as having run, with no exit code yet.
 */
export function closeTurn(state: TurnState, status: Exclude<TurnStatus, "inProgress">, atMs: number): Step {
  return chain(state,
    (current) => closeMessage(current, status === "completed" ? "final_answer" : null, atMs),
    (current) => closeThought(current, atMs),
    (current) => Object.keys(current.tools).reduce<Step>((done, id) => {
      const item = itemOf(done.state, id);
      if (!item) return done;
      const ended = (status === "completed" && item.type === "commandExecution"
        ? { ...item, status: "completed", exitCode: null, aggregatedOutput: item.aggregatedOutput ?? "(still running in the background when the turn ended)" }
        // A stopped turn's command or file change was declined, as stock shows it; another tool call has no such status.
        : { ...item, status: status === "interrupted" && item.type !== "dynamicToolCall" ? "declined" : "failed" }) as ThreadItem;
      return { state: withItem(done.state, ended), out: [...done.out, completed(done.state, ended, atMs)] };
    }, step({ ...current, tools: {} })),
  );
}

/** The turn as history keeps it. */
export function turnRecord(state: TurnState, status: TurnStatus, error: string | null, atMs: number): Turn {
  const done = status !== "inProgress";
  return {
    id: state.turnId, items: [...state.items], itemsView: "full", status,
    error: status === "failed" ? { message: error ?? "Antigravity turn failed.", codexErrorInfo: null, additionalDetails: null } : null,
    startedAt: Math.floor(state.startedAtMs / 1000), completedAt: done ? Math.floor(atMs / 1000) : null, durationMs: done ? Math.max(0, atMs - state.startedAtMs) : null,
  };
}
