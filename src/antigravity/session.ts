// An Antigravity chat while it is open: its `agy acp` process, the CLI session in it, and the turn that runs. What a
// turn shows is folded by turn.ts and what the chat keeps is the log of store.ts; held here is only what lives no longer
// than the process: its handle, the running turn, the queue.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Logger } from "../log.js";
import { invalidRequest, type JsonObject, type QueuedSubmissionLike, type TokenUsageBreakdown, type Turn, type TurnStatus, type UserInput } from "../protocol/codex.js";
import { startedTurn } from "../protocol/turnPagination.js";
import { AcpFailure, startAcp, type AcpConnection, type AcpSpawn } from "./acp.js";
import { expandDiffs, type ReadText } from "./diff.js";
import { promptBlocks } from "./input.js";
import type { CliModel } from "./models.js";
import { approvalRequest, antigravityMode, permissionOutcome, unaskedDecision, type PermissionOption } from "./permissions.js";
import { handoff, type ThreadEvent, type ThreadRecord } from "./store.js";
import { addUsage, applyUpdate, closeTurn, declineTool, NO_USAGE, openTurn, promptUsage, turnRecord, userMessage, type Notification, type ParseCommand, type TurnState } from "./turn.js";

/** ACP's "authentication required". */
const AUTH_REQUIRED = -32000;
const METHOD_NOT_FOUND = -32601;
/** How long a stopped turn waits for the CLI to end its prompt before its process is closed. */
const CANCEL_WAIT_MS = 5_000;

export const NOT_SIGNED_IN = "Antigravity CLI is not signed in. Run `ccodex auth antigravity` (or `agy acp --login`) in a terminal and sign in with Google, then send the message again.";
const INSTALL = "curl -fsSL https://antigravity.google/cli/install.sh | bash";

/** A file's text as it is now, for the patch of a change the agent asks about. */
export const readText: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** What the session needs of the world around it: all of it passed in. */
export interface SessionHost {
  readonly threadId: string;
  readonly logger: Logger;
  /** How to start the CLI in ACP mode in a directory. */
  spawn(cwd: string): AcpSpawn;
  /** The chat as its log has it. */
  record(): ThreadRecord;
  append(events: readonly ThreadEvent[]): void;
  /** A notification to every client with the chat open. */
  emit(method: string, params: unknown): void;
  /** A question to those clients (an approval); rejects when cancelled. */
  ask(method: string, params: unknown): Promise<any>;
  cancelAsks(): void;
  /** The CLI's id of the chat's model at its effort. */
  cliModel(record: ThreadRecord): string;
  /** The models the CLI offers this login. */
  onModels(models: readonly CliModel[]): void;
  /** What a file holds now (undefined: no such file). */
  read: ReadText;
  /** A shell command as what it reads, lists or searches. */
  commandActions: ParseCommand;
  onTurnCompleted(turnId: string): void;
  now(): number;
}

/** The CLI session open in the process. */
interface Opened {
  readonly sessionId: string;
  readonly modes: readonly string[];
  mode: string | null;
  model: string | null;
  /** It has none of the chat's history yet: the next prompt brings it. */
  fresh: boolean;
}

interface RunningTurn {
  state: TurnState;
  interrupted: boolean;
  cancelTimer?: NodeJS.Timeout;
}

export interface AntigravitySession {
  readonly busy: boolean;
  /** Its CLI process runs. */
  readonly loaded: boolean;
  readonly activeAt: number;
  readonly queued: QueuedSubmissionLike[];
  liveTurn(): Turn | undefined;
  startTurn(params: JsonObject): Promise<Turn>;
  interrupt(): void;
  /** Context the model gets before the next message (no reply of its own). */
  inject(text: string): void;
  /** The chat's settings changed: the open CLI session follows. */
  applySettings(): Promise<void>;
  /** The CLI session no longer matches the chat (its history was cut): the next message opens a new one. */
  reset(): void;
  close(): void;
}

/** `agy acp`: the Antigravity CLI's ACP server over stdio, in the chat's directory. */
export function antigravitySpawn(binary: string, cwd: string, env: Record<string, string | undefined> = process.env): AcpSpawn {
  const { CCODEX_SHIM_ACTIVE: _shim, ...rest } = env;
  return { command: binary, args: ["acp"], cwd, env: rest };
}

/** Why a turn failed, as the chat says it. */
export function failureText(error: unknown): string {
  if (error instanceof AcpFailure && error.code === AUTH_REQUIRED) return `${NOT_SIGNED_IN} (${error.message})`;
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|could not start/u.test(message) ? `Antigravity CLI did not start: ${message}. Install it with \`${INSTALL}\` or set antigravity_binary in ~/.ccodex/config.toml.` : `Antigravity: ${message}`;
}

export function createAntigravitySession(host: SessionHost): AntigravitySession {
  const { threadId } = host;
  let acp: AcpConnection | undefined;
  let opening: Promise<Opened> | undefined;
  let turn: RunningTurn | undefined;
  /** A prompt is with the CLI: its session updates are the turn's (a loaded session replays its history first). */
  let prompting = false;
  /** User messages a session load replayed: none, for a chat with history, and the CLI had lost the session. */
  let replayed = 0;
  let activeAt = host.now();
  const queued: QueuedSubmissionLike[] = [];
  const injected: string[] = [];

  const send = (out: readonly Notification[]) => { for (const { method, params } of out) host.emit(method, params); };

  const closeProcess = () => {
    const closing = acp;
    acp = undefined;
    opening = undefined;
    prompting = false;
    closing?.close();
  };

  const onNotification = (source: AcpConnection) => (method: string, params: any) => {
    if (source !== acp || method !== "session/update") return;
    if (!prompting) {
      if (params.update?.sessionUpdate === "user_message_chunk") replayed += 1;
      return;
    }
    if (!turn || turn.interrupted) return;
    activeAt = host.now();
    const next = applyUpdate(turn.state, params.update ?? {}, host.now(), host.record().total, host.commandActions);
    turn.state = next.state;
    send(next.out);
  };

  /** The CLI wants a tool call confirmed: the App's approval prompt, or the answer the chat's permissions give. */
  const onRequest = (source: AcpConnection) => async (method: string, params: any): Promise<unknown> => {
    if (method !== "session/request_permission") throw new Error(`Method not supported: ${method}`);
    const running = turn;
    if (source !== acp || !running || !prompting || running.interrupted) return { outcome: { outcome: "cancelled" } };
    const call: JsonObject = params.toolCall ?? {};
    const itemId = String(call.toolCallId ?? "");
    const options: PermissionOption[] = Array.isArray(params.options) ? params.options : [];
    // The request carries the change's patch (a snippet, made whole here); a call the CLI did not tell shows from it.
    const known = running.state.items.some((item) => item.id === itemId);
    const content = Array.isArray(call.content) ? expandDiffs(call.content as JsonObject[], host.read) : call.content;
    const shown = applyUpdate(running.state, { ...call, content, sessionUpdate: known ? "tool_call_update" : "tool_call", status: "pending" }, host.now(), NO_USAGE, host.commandActions);
    running.state = shown.state;
    send(shown.out);
    const record = host.record();
    // In plan mode the turn ends with the plan: the App's own control leaves plan mode, not the model.
    let decision: unknown = record.plan && call.kind === "switch_mode" ? "decline" : unaskedDecision(record.permissionMode);
    if (decision === undefined) {
      const request = approvalRequest(running.state.items.find((item) => item.id === itemId), {
        threadId, turnId: running.state.turnId, itemId, cwd: record.cwd, title: String(call.title ?? ""), startedAtMs: host.now(),
      });
      decision = await host.ask(request.method, request.params).then((answer) => answer?.decision, () => "cancel");
    }
    const outcome = permissionOutcome(decision, options);
    const allowed = outcome.outcome === "selected" && options.find((option) => option.optionId === outcome.optionId)?.kind.startsWith("allow");
    if (!allowed && turn === running) running.state = declineTool(running.state, itemId);
    // As stock's "cancel": the turn stops with the action.
    if (outcome.outcome === "cancelled") interrupt();
    return { outcome };
  };

  const open = async (): Promise<Opened> => {
    const record = host.record();
    const connection: AcpConnection = startAcp(host.spawn(record.cwd), {
      onNotification: (method, params) => onNotification(connection)(method, params),
      onRequest: (method, params) => onRequest(connection)(method, params),
      onExit: (reason) => {
        host.logger.info("antigravity.process.exited", { threadId, reason });
        if (acp === connection) closeProcess();
      },
    });
    acp = connection;
    // No file system or terminal of the client's: the CLI reads, writes and runs on this machine itself.
    await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "ccodex", title: "CCodex", version: "1" },
    });
    const opened = (answer: JsonObject, sessionId: string, fresh: boolean): Opened => {
      if (Array.isArray(answer.models?.availableModels)) host.onModels(answer.models.availableModels);
      return {
        sessionId, fresh, modes: (answer.modes?.availableModes ?? []).map((mode: JsonObject) => String(mode.id)),
        mode: answer.modes?.currentModeId ?? null, model: answer.models?.currentModelId ?? null,
      };
    };
    if (record.sessionId) {
      try {
        replayed = 0;
        const loaded = opened(await connection.request("session/load", { sessionId: record.sessionId, cwd: record.cwd, mcpServers: [] }) ?? {}, record.sessionId, false);
        // The Antigravity CLI opens an empty session for an id it doesn't have: what it replays tells.
        if (record.turns.length && !replayed) {
          host.logger.warn("antigravity.session.lost", { threadId, sessionId: record.sessionId, error: "no history replayed" });
          return { ...loaded, fresh: true };
        }
        return loaded;
      } catch (error) {
        if (error instanceof AcpFailure && error.code === AUTH_REQUIRED) throw error;
        if (acp !== connection) throw error;
        // The CLI no longer has the session (its files are gone, the chat moved to another directory).
        host.logger.warn("antigravity.session.lost", { threadId, sessionId: record.sessionId, error: String(error) });
      }
    }
    const created: JsonObject = await connection.request("session/new", { cwd: record.cwd, mcpServers: [] });
    return opened(created, String(created.sessionId), true);
  };

  const ensureOpen = (): Promise<Opened> => {
    opening ??= open().catch((error: unknown) => {
      closeProcess();
      throw error;
    });
    return opening;
  };

  /** The open session takes the chat's approval mode and model. */
  const applyTo = async (session: Opened): Promise<void> => {
    const record = host.record();
    const connection = acp;
    if (!connection) return;
    const mode = antigravityMode(record, session.modes);
    if (mode !== session.mode) {
      await connection.request("session/set_mode", { sessionId: session.sessionId, modeId: mode });
      session.mode = mode;
    }
    const model = host.cliModel(record);
    if (model !== session.model) {
      // A CLI without model switching keeps its own model.
      await connection.request("session/set_model", { sessionId: session.sessionId, modelId: model })
        .catch((error: unknown) => { if (!(error instanceof AcpFailure && error.code === METHOD_NOT_FOUND)) throw error; });
      session.model = model;
    }
  };

  const finish = (running: RunningTurn, status: Exclude<TurnStatus, "inProgress">, error: string | null, usage: TokenUsageBreakdown, session: Opened | undefined): void => {
    if (turn !== running) return;
    clearTimeout(running.cancelTimer);
    turn = undefined;
    prompting = false;
    const atMs = host.now();
    const closed = closeTurn(running.state, status, atMs);
    send(closed.out);
    const record = turnRecord(closed.state, status, error, atMs);
    const before = host.record();
    host.append([
      { type: "turn", at: Math.floor(atMs / 1000), turn: record, total: addUsage(before.total, usage), ...(closed.state.context ? { context: closed.state.context } : {}) },
      // The session took the prompt: it holds the chat up to this turn.
      ...(session && before.sessionId !== session.sessionId ? [{ type: "session" as const, at: Math.floor(atMs / 1000), sessionId: session.sessionId }] : []),
    ]);
    if (record.error) host.emit("error", { threadId, turnId: record.id, willRetry: false, error: record.error });
    host.emit("turn/completed", { threadId, turn: startedTurn(record) });
    const next = queued.shift();
    if (!next) host.emit("thread/status/changed", { threadId, status: { type: "idle" } });
    host.onTurnCompleted(record.id);
    if (next) {
      host.emit("thread/queue/changed", { threadId });
      void startTurn({ input: next.input, clientUserMessageId: next.clientUserMessageId })
        .catch((failure: unknown) => host.logger.warn("antigravity.queue.start-failed", { threadId, error: String(failure) }));
    }
  };

  const run = async (running: RunningTurn, input: readonly UserInput[]): Promise<void> => {
    let session: Opened | undefined;
    try {
      session = await ensureOpen();
      if (running.interrupted) return finish(running, "interrupted", null, NO_USAGE, undefined);
      await applyTo(session);
      const record = host.record();
      const context = [...(session.fresh ? [handoff(record.turns)] : []), ...injected.splice(0)];
      const prompt = await promptBlocks(input, record.cwd, context);
      if (running.interrupted || !acp) return finish(running, "interrupted", null, NO_USAGE, undefined);
      prompting = true;
      const result: JsonObject = await acp.request("session/prompt", { sessionId: session.sessionId, prompt }) ?? {};
      const stopped = running.interrupted || result.stopReason === "cancelled";
      // A prompt stopped early may never have reached the model: a session new to the chat gets its history again.
      if (!stopped) session.fresh = false;
      // The context is full: the answer was cut short.
      const error = result.stopReason === "max_tokens" ? "Antigravity stopped: the model's context window or output limit was reached." : null;
      finish(running, stopped ? "interrupted" : error ? "failed" : "completed", error, promptUsage(result.usage), session.fresh ? undefined : session);
    } catch (error) {
      host.logger.warn("antigravity.turn.failed", { threadId, error: String(error) });
      // What the CLI session holds of this turn is unknown: the next message opens it anew.
      closeProcess();
      finish(running, running.interrupted ? "interrupted" : "failed", failureText(error), NO_USAGE, undefined);
    }
  };

  const startTurn = async (params: JsonObject): Promise<Turn> => {
    if (turn) throw invalidRequest("An Antigravity turn is running: queue the message, or stop the turn first.");
    const input: UserInput[] = (params.input ?? []).map((item: UserInput) => item.type === "text" ? { type: "text", text: item.text, text_elements: item.text_elements ?? [] } : item);
    const atMs = host.now();
    activeAt = atMs;
    const running: RunningTurn = {
      state: openTurn({ threadId, turnId: params.turnId ?? randomUUID(), cwd: host.record().cwd, startedAtMs: atMs }),
      interrupted: false,
    };
    turn = running;
    // Announced after the answer to `turn/start`, as stock does: a client binds its own copy of the message to the turn
    // that answer names.
    setImmediate(() => {
      host.emit("turn/started", { threadId, turn: startedTurn(turnRecord(running.state, "inProgress", null, atMs)) });
      host.emit("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
      const shown = userMessage(running.state, input, params.clientUserMessageId ?? null, host.now());
      running.state = shown.state;
      send(shown.out);
      void run(running, input);
    });
    return startedTurn(turnRecord(running.state, "inProgress", null, atMs));
  };

  const interrupt = (): void => {
    const running = turn;
    if (!running || running.interrupted) return;
    running.interrupted = true;
    host.cancelAsks();
    // Still opening its CLI session (a CLI that hangs there never answers): the process goes, and the turn with it.
    if (!prompting) return closeProcess();
    void opening?.then((session) => acp?.notify("session/cancel", { sessionId: session.sessionId }), () => undefined);
    // A CLI that does not end its prompt is closed: the turn ends all the same.
    running.cancelTimer = setTimeout(() => { if (turn === running) closeProcess(); }, CANCEL_WAIT_MS);
    running.cancelTimer.unref();
  };

  return {
    get busy() { return turn !== undefined; },
    get loaded() { return acp !== undefined; },
    get activeAt() { return activeAt; },
    queued,
    liveTurn: () => turn && turnRecord(turn.state, "inProgress", null, host.now()),
    startTurn,
    interrupt,
    inject: (text) => { if (text) injected.push(text); },
    applySettings: async () => {
      const session = await opening?.catch(() => undefined);
      if (session) await applyTo(session);
    },
    reset: closeProcess,
    close: () => {
      if (turn) interrupt();
      closeProcess();
    },
  };
}
