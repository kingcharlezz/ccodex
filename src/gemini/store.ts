// A Gemini chat's history as CCodex keeps it: `~/.ccodex/state/gemini/<thread id>.jsonl`, one event a line, only ever
// appended to. The chat is the fold of its events (pure); reading and appending the file are the only IO.
//
// The Gemini CLI keeps the model's context in a session of its own. The log names the session that holds all of the
// chat's turns; when none does (a fork, an edit that cut the history, a session the CLI lost), the chat's next
// message opens a new session and brings the history along as a transcript.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadItem, TokenUsageBreakdown, Turn } from "../protocol/codex.js";
import type { PermissionChoice } from "./permissions.js";
import { NO_USAGE } from "./turn.js";

export type ThreadEvent =
  | { readonly type: "created"; readonly at: number; readonly cwd: string; readonly model: string; readonly permissionMode: PermissionChoice; readonly plan: boolean; readonly forkedFromId?: string | null }
  | { readonly type: "settings"; readonly at: number; readonly cwd?: string; readonly model?: string; readonly permissionMode?: PermissionChoice; readonly plan?: boolean }
  | { readonly type: "named"; readonly at: number; readonly name: string }
  /** The CLI session that holds every turn so far (null: none does). */
  | { readonly type: "session"; readonly at: number; readonly sessionId: string | null }
  | { readonly type: "turn"; readonly at: number; readonly turn: Turn; readonly total?: TokenUsageBreakdown; readonly context?: { used: number; size: number } | null }
  /** History cut to its first `turns` turns (a rollback, an edited message). */
  | { readonly type: "truncated"; readonly at: number; readonly turns: number };

export interface ThreadRecord {
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly permissionMode: PermissionChoice;
  readonly plan: boolean;
  readonly name: string | null;
  readonly forkedFromId: string | null;
  /** Unix seconds. */
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sessionId: string | null;
  readonly turns: readonly Turn[];
  /** Tokens of all the chat's turns, and the context its last request held. */
  readonly total: TokenUsageBreakdown;
  readonly context: { readonly used: number; readonly size: number } | null;
}

/** The chat after one more event; undefined until its `created`. */
export function applyEvent(record: ThreadRecord | undefined, id: string, event: ThreadEvent): ThreadRecord | undefined {
  if (event.type === "created") {
    return {
      id, cwd: event.cwd, model: event.model, permissionMode: event.permissionMode, plan: event.plan, name: null, forkedFromId: event.forkedFromId ?? null,
      createdAt: event.at, updatedAt: event.at, sessionId: null, turns: [], total: NO_USAGE, context: null,
    };
  }
  if (!record) return undefined;
  switch (event.type) {
    case "settings": {
      const { type: _type, at: _at, ...settings } = event;
      return { ...record, ...settings };
    }
    case "named": return { ...record, name: event.name };
    case "session": return { ...record, sessionId: event.sessionId };
    case "turn": return {
      ...record, turns: [...record.turns.filter((turn) => turn.id !== event.turn.id), event.turn], updatedAt: event.at,
      total: event.total ?? record.total, context: event.context === undefined ? record.context : event.context,
    };
    case "truncated": return { ...record, turns: record.turns.slice(0, event.turns), updatedAt: event.at };
  }
}

export function foldThread(id: string, events: readonly ThreadEvent[]): ThreadRecord | undefined {
  return events.reduce<ThreadRecord | undefined>((record, event) => applyEvent(record, id, event), undefined);
}

/** The lines of a log as events; a line cut short by a crash (or not an event) is passed over. */
export function parseEvents(text: string): ThreadEvent[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const event = JSON.parse(line) as ThreadEvent;
      return event && typeof event === "object" && typeof event.type === "string" ? [event] : [];
    } catch {
      return [];
    }
  });
}

/** The first thing the user said, as a row's preview. */
export function previewOf(record: ThreadRecord): string {
  for (const turn of record.turns) {
    for (const item of turn.items) {
      if (item.type !== "userMessage") continue;
      const text = item.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ").replace(/\s+/gu, " ").trim();
      if (text) return text.slice(0, 200);
    }
  }
  return "";
}

const itemText = (item: ThreadItem): string => item.type === "userMessage" ? item.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n")
  : item.type === "agentMessage" ? item.text : "";

/** Chats whose messages hold the term (any case), each with the text around its first match. */
export function searchThreads(records: Iterable<ThreadRecord>, term: string): Map<string, string> {
  const needle = term.toLowerCase();
  const found = new Map<string, string>();
  if (!needle) return found;
  for (const record of records) {
    const texts = [record.name ?? "", ...record.turns.flatMap((turn) => turn.items.map(itemText))];
    const text = texts.find((candidate) => candidate.toLowerCase().includes(needle));
    if (text === undefined) continue;
    const at = text.toLowerCase().indexOf(needle);
    found.set(record.id, text.slice(Math.max(0, at - 50), at + needle.length + 100).replace(/\s+/gu, " ").trim());
  }
  return found;
}

const HANDOFF_CHARS = 60_000;
const OUTPUT_CHARS = 1_500;

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;

/** A turn as a transcript reads: who said what, which commands ran, which files changed. */
function turnTranscript(turn: Turn): string[] {
  return turn.items.flatMap((item) => {
    if (item.type === "userMessage") {
      const text = itemText(item);
      return text ? [`User:\n${text}`] : [];
    }
    if (item.type === "agentMessage") return item.text ? [`Assistant:\n${item.text}`] : [];
    if (item.type === "commandExecution") return [`Assistant ran \`${item.command}\` (${item.status})${item.aggregatedOutput ? `:\n${clip(item.aggregatedOutput, OUTPUT_CHARS)}` : ""}`];
    if (item.type === "fileChange") return item.changes.length ? [`Assistant ${item.status === "completed" ? "changed" : `proposed changes (${item.status}) to`} ${item.changes.map((change) => change.path).join(", ")}`] : [];
    if (item.type === "dynamicToolCall") return [`Assistant used ${item.tool} (${item.status})`];
    return [];
  });
}

/**
 * The chat so far for a session that has none of it: its transcript, the newest turns whole and as many earlier ones
 * as fit. "" for a chat without history.
 */
export function handoff(turns: readonly Turn[]): string {
  const kept: string[] = [];
  let size = 0;
  for (const turn of [...turns].reverse()) {
    const text = turnTranscript(turn).join("\n\n");
    if (!text) continue;
    if (kept.length && size + text.length > HANDOFF_CHARS) break;
    kept.unshift(clip(text, HANDOFF_CHARS));
    size += text.length;
  }
  if (!kept.length) return "";
  const earlier = turns.length - kept.length;
  return [
    "This conversation continues an earlier one that is not in your context. Its transcript so far follows, oldest first"
      + `${earlier > 0 ? ` (${earlier} earlier turn${earlier === 1 ? "" : "s"} left out)` : ""}. Files and commands in it are as they were then: check their state before relying on it.`,
    "<earlier_conversation>", kept.join("\n\n"), "</earlier_conversation>",
    "The user's next message:",
  ].join("\n");
}

// ---- the files ----

export const threadPath = (directory: string, id: string) => join(directory, `${id}.jsonl`);

export function appendEvents(directory: string, id: string, events: readonly ThreadEvent[]): void {
  if (!events.length) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  appendFileSync(threadPath(directory, id), events.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
}

export function readThread(directory: string, id: string): ThreadRecord | undefined {
  const path = threadPath(directory, id);
  return existsSync(path) ? foldThread(id, parseEvents(readFileSync(path, "utf8"))) : undefined;
}

/** Every chat in the directory (a file that folds to no chat is passed over). */
export function readThreads(directory: string): ThreadRecord[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readThread(directory, name.slice(0, -".jsonl".length)) ?? []);
}
