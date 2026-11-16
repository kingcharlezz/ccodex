// The Gemini side of the gateway: chats run by the Gemini CLI (`gemini --acp`), listed and driven like stock's threads.
// A chat is its log (store.ts); the maps here only cache the folded logs and hold the sessions that are open.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { findGemini, type Config } from "../config.js";
import type { Logger } from "../log.js";
import type { Meta } from "../meta.js";
import { invalidParams, invalidRequest, type JsonObject, type Thread, type Turn } from "../protocol/codex.js";
import { historyCursors, occurrencesPage, paginateItems, paginateTurns, turnOccurrences } from "../protocol/turnPagination.js";
import { toTrash } from "../trash.js";
import { AUTO_MODEL, GEMINI_PROVIDER, geminiModelLabel, isGeminiModel, listedModels, mapGeminiModel, type GeminiModel } from "./models.js";
import type { GeminiSettings } from "./permissions.js";
import { createGeminiSession, geminiSpawn, type GeminiSession } from "./session.js";
import { appendEvents, applyEvent, handoff, readThreads, searchThreads, threadPath, type ThreadEvent, type ThreadRecord } from "./store.js";
import { geminiThread, otherProviderRequested, settingsFrom, settingsOf, settingsResponse, SWITCH_UNSUPPORTED, threadSettings } from "./thread.js";
import { usageNotification } from "./turn.js";

/** A client connection, as far as the Gemini layer handles one: it only passes it on. */
type Client = object;

/** What the Gemini layer needs of the gateway (the Gateway itself fits). */
export interface GeminiHost<C extends Client = Client> {
  readonly config: Config;
  readonly logger: Logger;
  readonly meta: Pick<Meta, "isArchived" | "setArchived" | "section" | "forget" | "entries">;
  /** Stock's sections by id (a row names its section from here). */
  readonly sections: ReadonlyMap<string, JsonObject>;
  readonly titles: { track(threadId: string): void };
  emit(threadId: string, method: string, params: unknown): void;
  subscribe(threadId: string, connection: C): void;
  unsubscribe(threadId: string, connection: C): void;
  subscribers(threadId: string): ReadonlySet<C>;
  serverRequest(threadId: string, method: string, params: unknown): Promise<any>;
  cancelServerRequests(threadId: string): void;
}

export interface GeminiThreads<C extends Client = Client> {
  /** The Gemini CLI is on this machine. */
  available(): boolean;
  isGeminiModel(model: unknown): boolean;
  owns(threadId: string): boolean;
  loadedIds(): string[];
  /** Every chat as a list row. */
  threads(): Thread[];
  models(): JsonObject[];
  search(term: string): Map<string, string>;
  rename(threadId: string, name: string): JsonObject;
  rateLimits(): JsonObject;
  /** A chat for the `/cc` status card. */
  state(threadId: string): JsonObject;
  /**
   * A chat nothing was said in yet is the App's new-chat draft, whose model the user may still change: `born` a Gemini
   * chat, or `adopted` from the provider that started it. Undefined for any other chat.
   */
  draft(threadId: string): "born" | "adopted" | undefined;
  /**
   * Another provider's draft becomes a Gemini chat under its own id (the App opens a new chat before its model is
   * picked). The draft stays where it was, behind the Gemini chat, until a message is sent.
   */
  adopt(threadId: string, cwd: string, params: JsonObject): void;
  /** A draft stops being a Gemini chat (another provider's model was picked for it); its settings as it was one. */
  release(threadId: string): GeminiSettings;
  handle(connection: C, method: string, params: JsonObject): Promise<unknown>;
  start(): void;
  close(): void;
}

/** As stock unloads a quiet thread: a chat's CLI process closes after this long without a turn. */
const IDLE_MS = Number(process.env.CCODEX_E2E_IDLE_MS) || 30 * 60_000;
/** Gemini CLI processes kept at most; the chat used longest ago gives its up first. */
const MAX_PROCESSES = Number(process.env.CCODEX_E2E_MAX_PROCESSES) || 10;
const BINARY_CACHE_MS = 30_000;

const seconds = (ms: number) => Math.floor(ms / 1000);

export function createGeminiThreads<C extends Client>(host: GeminiHost<C>, now: () => number = Date.now): GeminiThreads<C> {
  const { config, logger } = host;
  const prefix = config.geminiModelPrefix;
  const directory = join(config.dataDir, "gemini");
  const modelsPath = join(config.dataDir, "gemini-models.json");
  /** The chats, folded from their logs. */
  const records = new Map<string, ThreadRecord>();
  /** Events of chats nothing was said in yet: written with their first turn, as stock writes a rollout. */
  const unwritten = new Map<string, ThreadEvent[]>();
  /** Side chats: never written, never listed. */
  const ephemeral = new Set<string>();
  /** Drafts another provider started, taken over when a Gemini model was picked for them. */
  const adopted = new Set<string>();
  const sessions = new Map<string, GeminiSession>();
  let knownModels: readonly GeminiModel[] | undefined;
  let binary: { at: number; path: string | undefined } | undefined;
  let sweeper: NodeJS.Timeout | undefined;

  // ---- the CLI and its models ----

  const geminiBinary = (): string | undefined => {
    if (!binary || now() - binary.at > BINARY_CACHE_MS) binary = { at: now(), path: findGemini(config) };
    return binary.path;
  };

  const onModels = (models: readonly GeminiModel[]): void => {
    if (JSON.stringify(models) === JSON.stringify(knownModels)) return;
    knownModels = models;
    const temporary = `${modelsPath}.${process.pid}.tmp`;
    void writeFile(temporary, JSON.stringify({ models }), { mode: 0o600 }).then(() => rename(temporary, modelsPath))
      .catch((error: unknown) => logger.warn("gemini.models.unsaved", { error: String(error) }));
  };

  // ---- the chats ----

  const recordOf = (threadId: string): ThreadRecord => {
    const record = records.get(threadId);
    if (!record) throw invalidParams(`thread not found: ${threadId}`);
    return record;
  };

  const append = (threadId: string, events: readonly ThreadEvent[]): void => {
    const next = events.reduce<ThreadRecord | undefined>((record, event) => applyEvent(record, threadId, event), records.get(threadId));
    if (next) records.set(threadId, next);
    if (ephemeral.has(threadId)) return;
    const held = unwritten.get(threadId);
    if (held && !events.some((event) => event.type === "turn")) return void held.push(...events);
    unwritten.delete(threadId);
    appendEvents(directory, threadId, [...held ?? [], ...events]);
  };

  const session = (threadId: string): GeminiSession => {
    const open = sessions.get(threadId);
    if (open) return open;
    recordOf(threadId);
    const created = createGeminiSession({
      threadId, logger, now,
      spawn: (cwd) => geminiSpawn(geminiBinary() ?? "gemini", cwd),
      record: () => recordOf(threadId),
      append: (events) => append(threadId, events),
      emit: (method, params) => host.emit(threadId, method, params),
      ask: (method, params) => host.serverRequest(threadId, method, params),
      cancelAsks: () => host.cancelServerRequests(threadId),
      onModels,
      onTurnCompleted: () => undefined,
    });
    sessions.set(threadId, created);
    return created;
  };

  const status = (threadId: string): Thread["status"] => {
    const open = sessions.get(threadId);
    return open?.busy ? { type: "active", activeFlags: [] } : open ? { type: "idle" } : { type: "notLoaded" };
  };

  /** The row with what meta.json keeps of it: its section and archive flag. */
  const row = (record: ThreadRecord): Thread => {
    const thread = geminiThread(record, prefix, { status: status(record.id), ephemeral: ephemeral.has(record.id) });
    const section = host.meta.section(record.id);
    return {
      ...thread,
      ...(section ? { section: host.sections.get(section.sectionId) ?? { id: section.sectionId, name: "", appearance: null }, sectionEnteredAt: section.enteredAt } : {}),
      archived: host.meta.isArchived(record.id),
    };
  };

  /** History with the running turn. */
  const turnsOf = (threadId: string): Turn[] => {
    const live = sessions.get(threadId)?.liveTurn();
    return [...recordOf(threadId).turns, ...live ? [live] : []];
  };

  // ---- settings ----

  const refuseOtherProvider = (params: JsonObject): void => {
    if (otherProviderRequested(params, prefix)) throw invalidRequest(SWITCH_UNSUPPORTED);
  };

  /** The chat takes the settings a request carries; every client with it open learns a change. */
  const updateSettings = async (threadId: string, params: JsonObject): Promise<void> => {
    refuseOtherProvider(params);
    const current = settingsOf(recordOf(threadId));
    const next = settingsFrom(params, current, prefix);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    append(threadId, [{ type: "settings", at: seconds(now()), ...next }]);
    host.emit(threadId, "thread/settings/updated", { threadId, threadSettings: threadSettings(next, prefix) });
    const open = sessions.get(threadId);
    // The CLI works in the directory it started in: a chat moved to another one gets a new process (and CLI session).
    if (next.cwd !== current.cwd && !open?.busy) open?.reset();
    else await open?.applySettings();
  };

  // ---- requests ----

  /** A chat with nothing said in it, under a new id or a draft's. */
  const create = (threadId: string, cwd: string, params: JsonObject): GeminiSettings => {
    const settings = settingsFrom(params, { cwd: params.cwd ?? cwd, model: AUTO_MODEL, permissionMode: "default", plan: false }, prefix);
    unwritten.set(threadId, []);
    append(threadId, [{ type: "created", at: seconds(now()), ...settings }]);
    session(threadId);
    return settings;
  };

  const draft = (threadId: string): "born" | "adopted" | undefined =>
    !unwritten.has(threadId) || sessions.get(threadId)?.busy ? undefined : adopted.has(threadId) ? "adopted" : "born";

  const startThread = (connection: C, params: JsonObject): JsonObject => {
    const threadId = uuidv7();
    const settings = create(threadId, process.cwd(), params);
    host.subscribe(threadId, connection);
    const thread = row(recordOf(threadId));
    // After the response, as stock: Desktop hides its new-chat draft's `thread/started` only once it knows the id.
    setImmediate(() => host.emit(threadId, "thread/started", { thread }));
    host.titles.track(threadId);
    return { thread, ...settingsResponse(settings, prefix) };
  };

  const resume = (connection: C, params: JsonObject): JsonObject => {
    const threadId: string = params.threadId;
    const record = recordOf(threadId);
    host.subscribe(threadId, connection);
    session(threadId);
    const turns = turnsOf(threadId);
    const newest = turns.slice(-1);
    // Like stock, the context meter follows a resume.
    if (record.context) {
      const usage = usageNotification(threadId, newest[0]?.id ?? null, record.context, record.total);
      setImmediate(() => host.emit(threadId, usage.method, usage.params));
    }
    const settings = settingsOf(record);
    return {
      thread: { ...row(record), turns: params.excludeTurns ? [] : newest },
      ...settingsResponse(settings, prefix),
      collaborationMode: threadSettings(settings, prefix).collaborationMode,
      initialTurnsPage: params.initialTurnsPage ? paginateTurns(turns, params.initialTurnsPage) : null,
      ...historyCursors(newest),
    };
  };

  /** History cut to its first `keep` turns: no CLI session holds exactly that, so the next message opens a new one. */
  const truncate = (threadId: string, keep: number): void => {
    if (sessions.get(threadId)?.busy) throw invalidRequest("Cannot roll back while a turn is running.");
    const at = seconds(now());
    append(threadId, [{ type: "truncated", at, turns: keep }, { type: "session", at, sessionId: null }]);
    sessions.get(threadId)?.reset();
  };

  const turnIndex = (record: ThreadRecord, turnId: string): number => {
    const index = record.turns.findIndex((turn) => turn.id === turnId);
    if (index < 0) throw invalidParams(`turn not found: ${turnId}`);
    return index;
  };

  const fork = (connection: C, params: JsonObject): JsonObject => {
    const source = recordOf(params.threadId);
    const settings = settingsFrom(params, settingsOf(source), prefix);
    const threadId = uuidv7();
    const at = seconds(now());
    if (params.ephemeral) {
      // A side chat: its own turns only, the source's history as context for its CLI session.
      ephemeral.add(threadId);
      append(threadId, [{ type: "created", at, ...settings, forkedFromId: source.id }]);
      session(threadId).inject(handoff(source.turns));
      host.subscribe(threadId, connection);
      return { thread: row(recordOf(threadId)), ...settingsResponse(settings, prefix) };
    }
    const kept = params.lastTurnId ? source.turns.slice(0, turnIndex(source, params.lastTurnId) + 1)
      : params.beforeTurnId ? source.turns.slice(0, turnIndex(source, params.beforeTurnId)) : source.turns;
    append(threadId, [
      { type: "created", at, ...settings, forkedFromId: source.id },
      ...kept.map((turn) => ({ type: "turn" as const, at: turn.completedAt ?? at, turn })),
    ]);
    session(threadId);
    host.subscribe(threadId, connection);
    const thread = row(recordOf(threadId));
    setImmediate(() => host.emit(threadId, "thread/started", { thread }));
    return { thread: { ...thread, turns: params.excludeTurns ? [] : kept.slice(-25) }, ...settingsResponse(settings, prefix) };
  };

  /** The chat goes: its log into the trash (CCodex never deletes a chat for good). */
  const discard = (threadId: string): void => {
    sessions.get(threadId)?.close();
    sessions.delete(threadId);
    if (!ephemeral.delete(threadId) && !unwritten.delete(threadId)) {
      toTrash(config.dataDir, threadId, { moved: [threadPath(directory, threadId)] }, host.meta.entries(threadId));
      host.meta.forget(threadId);
    }
    records.delete(threadId);
  };

  const rename = (threadId: string, name: string): JsonObject => {
    recordOf(threadId);
    append(threadId, [{ type: "named", at: seconds(now()), name }]);
    host.emit(threadId, "thread/name/updated", { threadId, threadName: name });
    return {};
  };

  const queue = async (threadId: string, method: string, params: JsonObject): Promise<JsonObject> => {
    const open = session(threadId);
    const index = open.queued.findIndex((entry) => entry.id === params.queuedSubmissionId);
    const changed = () => host.emit(threadId, "thread/queue/changed", { threadId });
    switch (method) {
      case "thread/queue/add": {
        const queuedSubmission = { id: randomUUID(), input: params.input ?? [], clientUserMessageId: params.clientUserMessageId };
        if (open.busy) open.queued.push(queuedSubmission);
        else await open.startTurn({ input: queuedSubmission.input, clientUserMessageId: queuedSubmission.clientUserMessageId });
        changed();
        return { queuedSubmission };
      }
      case "thread/queue/delete":
        if (index >= 0) open.queued.splice(index, 1);
        changed();
        return { deleted: index >= 0 };
      case "thread/queue/update":
        if (index < 0) throw invalidRequest("queued message not found");
        open.queued[index] = { ...open.queued[index]!, input: params.input ?? [] };
        changed();
        return { queuedSubmission: open.queued[index] };
      case "thread/queue/reorder": {
        const order: string[] = params.queuedSubmissionIds ?? [];
        open.queued.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
        changed();
        return {};
      }
      default: {
        // thread/queue/start: a turn that runs waits for none; the message goes first in line.
        const entry = index >= 0 ? open.queued.splice(index, 1)[0] : open.queued.shift();
        if (!entry) throw invalidRequest("nothing queued");
        if (open.busy) {
          open.queued.unshift(entry);
          throw invalidRequest("A Gemini turn is running: the message runs when it ends.");
        }
        changed();
        return { turn: await open.startTurn({ input: entry.input, clientUserMessageId: entry.clientUserMessageId }) };
      }
    }
  };

  const handle = async (connection: C, method: string, params: JsonObject): Promise<unknown> => {
    if (method === "thread/start") return startThread(connection, params);
    const threadId: string = params.threadId;
    const record = recordOf(threadId);
    switch (method) {
      case "thread/resume": return resume(connection, params);
      case "thread/read": return { thread: { ...row(record), turns: params.includeTurns ? turnsOf(threadId) : [] } };
      case "thread/turns/list": return paginateTurns(turnsOf(threadId), params);
      case "thread/items/list": return paginateItems(turnsOf(threadId), params);
      case "thread/searchOccurrences": {
        if (!String(params.searchTerm ?? "").trim()) throw invalidRequest("thread/searchOccurrences requires a non-empty searchTerm");
        return occurrencesPage(turnOccurrences(turnsOf(threadId), params.searchTerm), params);
      }
      case "turn/start": {
        host.subscribe(threadId, connection);
        await updateSettings(threadId, params);
        // Desktop's description turn wants JSON matching its schema.
        if (params.outputSchema) session(threadId).inject(`Answer the next message with only a JSON object matching this JSON Schema, nothing else:\n${JSON.stringify(params.outputSchema)}`);
        return { turn: await session(threadId).startTurn(params) };
      }
      // ACP has no way to hand the model a message mid-turn.
      case "turn/steer": throw invalidRequest("Gemini takes no message while its turn runs: queue it, or stop the turn first.");
      case "turn/interrupt": {
        sessions.get(threadId)?.interrupt();
        return {};
      }
      case "thread/unsubscribe": {
        host.unsubscribe(threadId, connection);
        if (ephemeral.has(threadId) && !host.subscribers(threadId).size) discard(threadId);
        return { status: "unsubscribed" };
      }
      case "thread/name/set": return rename(threadId, String(params.name ?? ""));
      case "thread/archive":
      case "thread/unarchive": {
        if (ephemeral.has(threadId)) {
          discard(threadId);
          return {};
        }
        const archived = method === "thread/archive";
        host.meta.setArchived(threadId, archived);
        host.emit(threadId, archived ? "thread/archived" : "thread/unarchived", { threadId });
        return archived ? {} : { thread: row(record) };
      }
      case "thread/delete": {
        const side = ephemeral.has(threadId);
        discard(threadId);
        if (!side) host.emit(threadId, "thread/deleted", { threadId });
        return {};
      }
      case "thread/fork": return fork(connection, params);
      case "thread/rollback": {
        truncate(threadId, Math.max(0, record.turns.length - Number(params.numTurns ?? 1)));
        return { thread: { ...row(recordOf(threadId)), turns: turnsOf(threadId).slice(-25) } };
      }
      case "thread/revert": {
        truncate(threadId, turnIndex(record, String(params.beforeTurnId)));
        host.emit(threadId, "thread/reverted", { threadId });
        return { thread: row(recordOf(threadId)), ...historyCursors(turnsOf(threadId).slice(-1)) };
      }
      case "thread/settings/update": {
        await updateSettings(threadId, params);
        return {};
      }
      // The CLI's settings have no per-turn scope: the running turn's change stays for the chat.
      case "turn/settings/update": {
        if (!sessions.get(threadId)?.busy) return { status: "targetUnavailable" };
        await updateSettings(threadId, params);
        return { status: "applied" };
      }
      case "thread/metadata/update": return { thread: row(record) };
      case "thread/inject_items": {
        session(threadId).inject((params.items ?? []).map((item: JsonObject) => JSON.stringify(item)).join("\n"));
        return {};
      }
      case "thread/attachment/list":
      case "thread/backgroundTerminals/list": return { data: [], nextCursor: null };
      case "thread/backgroundTerminals/terminate":
      case "thread/backgroundTerminals/clean": return {};
      case "thread/goal/get": return { goal: null };
      case "thread/goal/clear": return { cleared: false };
      case "thread/queue/list": return { data: sessions.get(threadId)?.queued ?? [], nextCursor: null };
      case "thread/queue/add":
      case "thread/queue/delete":
      case "thread/queue/update":
      case "thread/queue/reorder":
      case "thread/queue/start": return queue(threadId, method, params);
      case "thread/goal/set": throw invalidRequest("Goals are not supported in Gemini threads.");
      case "thread/compact/start": throw invalidRequest("/compact is not supported in Gemini threads: the Gemini CLI compresses a long chat itself.");
      case "review/start":
      case "thread/shellCommand":
        throw invalidRequest(`${method === "review/start" ? "/review" : "!command"} is not supported in Gemini threads.`);
      default:
        throw invalidRequest(`${method} is not supported in Gemini threads.`);
    }
  };

  /**
   * A quiet chat's CLI process closes after IDLE_MS (the next message starts it again, on the CLI session it had), and
   * past MAX_PROCESSES the chats used longest ago give theirs up; a chat nobody has open is unloaded, as stock's is.
   */
  const sweep = (): void => {
    const quiet = [...sessions].filter(([, open]) => !open.busy);
    for (const [threadId, open] of quiet) {
      if (now() - open.activeAt < IDLE_MS) continue;
      open.reset();
      if (host.subscribers(threadId).size) continue;
      sessions.delete(threadId);
      host.emit(threadId, "thread/status/changed", { threadId, status: { type: "notLoaded" } });
      host.emit(threadId, "thread/closed", { threadId });
    }
    const running = quiet.filter(([, open]) => open.loaded).sort(([, left], [, right]) => left.activeAt - right.activeAt);
    const busy = [...sessions.values()].filter((open) => open.busy).length;
    for (const [, open] of running.slice(0, Math.max(0, running.length + busy - MAX_PROCESSES))) open.reset();
  };

  return {
    available: () => geminiBinary() !== undefined,
    isGeminiModel: (model) => isGeminiModel(model, prefix),
    owns: (threadId) => records.has(threadId),
    loadedIds: () => [...sessions.keys()].filter((threadId) => !ephemeral.has(threadId)),
    // A chat nothing was said in is no row yet, as stock's.
    threads: () => [...records.values()].filter((record) => !ephemeral.has(record.id) && (record.turns.length > 0 || sessions.get(record.id)?.busy)).map(row),
    models: () => geminiBinary() ? listedModels(knownModels).map((model) => mapGeminiModel(model, prefix)) : [],
    search: (term) => searchThreads([...records.values()].filter((record) => !ephemeral.has(record.id)), term),
    rename,
    rateLimits: () => {
      // The Gemini CLI reports no plan limits over ACP.
      const snapshot = { limitId: GEMINI_PROVIDER, limitName: "Gemini", primary: null, secondary: null, credits: null, planType: null, rateLimitReachedType: null };
      return { rateLimits: snapshot, rateLimitsByLimitId: { [GEMINI_PROVIDER]: snapshot } };
    },
    state: (threadId) => {
      const record = recordOf(threadId);
      const open = sessions.get(threadId);
      return {
        model: geminiModelLabel(record.model), permissionMode: record.permissionMode, plan: record.plan, cwd: record.cwd,
        loaded: open !== undefined, process: open?.loaded ?? false, turnId: open?.liveTurn()?.id ?? null, context: record.context,
      };
    },
    draft,
    adopt: (threadId, cwd, params) => {
      const settings = create(threadId, cwd, params);
      adopted.add(threadId);
      // Stock reports a thread's settings only when they change: the chat is on a Gemini model from here.
      host.emit(threadId, "thread/settings/updated", { threadId, threadSettings: threadSettings(settings, prefix) });
    },
    release: (threadId) => {
      if (!draft(threadId)) throw invalidRequest(SWITCH_UNSUPPORTED);
      const settings = settingsOf(recordOf(threadId));
      sessions.get(threadId)?.close();
      sessions.delete(threadId);
      unwritten.delete(threadId);
      adopted.delete(threadId);
      records.delete(threadId);
      return settings;
    },
    handle,
    start: () => {
      for (const record of readThreads(directory)) records.set(record.id, record);
      try {
        knownModels = (JSON.parse(readFileSync(modelsPath, "utf8")) as { models: GeminiModel[] }).models;
      } catch {
        // No list kept yet: the picker shows the models every login has.
      }
      sweeper = setInterval(sweep, Math.min(60_000, IDLE_MS / 4));
      sweeper.unref();
    },
    close: () => {
      clearInterval(sweeper);
      for (const open of sessions.values()) open.close();
    },
  };
}

