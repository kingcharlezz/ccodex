// Agent Client Protocol (https://agentclientprotocol.com) over a child's stdio: newline-delimited JSON-RPC 2.0, as
// `agy acp` speaks it. Framing and classification are pure; the process is the only IO here.
import { spawn } from "node:child_process";

export interface AcpError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** A request the agent answered with an error (its code tells why: -32000 is "not logged in"). */
export class AcpFailure extends Error {
  public constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
  }
}

/** What a line from the agent is. */
export type AcpFrame =
  | { readonly kind: "response"; readonly id: number; readonly result?: unknown; readonly error?: AcpError }
  | { readonly kind: "request"; readonly id: number | string; readonly method: string; readonly params: any }
  | { readonly kind: "notification"; readonly method: string; readonly params: any }
  | { readonly kind: "noise"; readonly line: string };

/** The whole lines in what was read so far, and the unfinished rest. */
export function splitLines(buffered: string, chunk: string): { readonly lines: readonly string[]; readonly rest: string } {
  const parts = `${buffered}${chunk}`.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((line) => line.trim()).filter(Boolean), rest };
}

/** A line as a frame; whatever is no JSON-RPC message (a stray log line on stdout) is noise. */
export function parseFrame(line: string): AcpFrame {
  let message: Record<string, any>;
  try {
    message = JSON.parse(line) as Record<string, any>;
  } catch {
    return { kind: "noise", line };
  }
  if (!message || typeof message !== "object") return { kind: "noise", line };
  if (typeof message.method === "string") {
    return message.id === undefined || message.id === null
      ? { kind: "notification", method: message.method, params: message.params ?? {} }
      : { kind: "request", id: message.id, method: message.method, params: message.params ?? {} };
  }
  if (typeof message.id === "number") {
    return { kind: "response", id: message.id, ...("error" in message && message.error ? { error: message.error as AcpError } : { result: message.result }) };
  }
  return { kind: "noise", line };
}

export const requestLine = (id: number, method: string, params: unknown) => `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
export const notificationLine = (method: string, params: unknown) => `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
export const resultLine = (id: number | string, result: unknown) => `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
export const errorLine = (id: number | string, error: AcpError) => `${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`;

export interface AcpHandlers {
  onNotification(method: string, params: any): void;
  /** A request of the agent's: what it resolves with is the result, a rejection the error. */
  onRequest(method: string, params: any): Promise<unknown>;
  /** The agent is gone (it exited, or could not start); requests in flight have failed already. */
  onExit(reason: string): void;
}

export interface AcpConnection {
  readonly pid: number | undefined;
  request<T = any>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
  close(): void;
}

export interface AcpSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

const STDERR_KEPT = 2_000;

/** Starts the agent and speaks ACP with it. */
export function startAcp(target: AcpSpawn, handlers: AcpHandlers): AcpConnection {
  const child = spawn(target.command, [...target.args], { cwd: target.cwd, env: target.env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let buffered = "";
  let stderr = "";
  let closed = false;
  let stopping = false;

  const write = (line: string) => {
    if (!closed && child.stdin.writable) child.stdin.write(line);
  };
  const end = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
    handlers.onExit(reason);
  };
  const dispatch = (frame: AcpFrame) => {
    if (frame.kind === "response") {
      const waiting = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) waiting?.reject(new AcpFailure(frame.error.code, frame.error.message, frame.error.data));
      else waiting?.resolve(frame.result);
    } else if (frame.kind === "notification") {
      handlers.onNotification(frame.method, frame.params);
    } else if (frame.kind === "request") {
      handlers.onRequest(frame.method, frame.params).then(
        (result) => write(resultLine(frame.id, result ?? null)),
        (error: unknown) => write(errorLine(frame.id, { code: -32603, message: error instanceof Error ? error.message : String(error) })),
      );
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const read = splitLines(buffered, chunk);
    buffered = read.rest;
    for (const line of read.lines) dispatch(parseFrame(line));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-STDERR_KEPT); });
  child.stdin.on("error", () => undefined);
  child.once("error", (error) => end(`could not start ${target.command}: ${error.message}`));
  child.once("exit", (code, signal) => {
    // What it last wrote to stderr tells why it went, unless it was told to go.
    const last = stopping ? undefined : stderr.trim().split("\n").at(-1);
    end(`${target.command} exited (${signal ?? `code ${code}`})${last ? `: ${last}` : ""}`);
  });

  return {
    get pid() { return child.pid; },
    request<T>(method: string, params: unknown): Promise<T> {
      if (closed) return Promise.reject(new Error(`${target.command} is not running`));
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write(requestLine(id, method, params));
      });
    },
    notify(method, params) { write(notificationLine(method, params)); },
    close() {
      if (closed) return;
      stopping = true;
      child.stdin.end();
      child.kill("SIGTERM");
      // An agent that ignores the signal goes all the same.
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2_000).unref();
    },
  };
}
