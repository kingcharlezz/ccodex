// The App's permission controls as Antigravity CLI modes, and its approval answers as ACP permission outcomes.
// All pure.
import { codexPermissions, permissionSettings, type CodexPermissions } from "../claude/sdk.js";
import type { JsonObject, ThreadItem } from "../protocol/codex.js";

/** The App's permission choice, named as the Claude layer names it (one mapping of the App's fields for both). */
export type PermissionChoice = Parameters<typeof permissionSettings>[1]["permissionMode"];

export interface AntigravitySettings {
  readonly cwd: string;
  /** The picker's model (`gemini-4-carbon`), without its effort. */
  readonly model: string;
  /** The reasoning effort picked for it; null: the model's default. */
  readonly effort: string | null;
  readonly permissionMode: PermissionChoice;
  readonly plan: boolean;
}

/** The Antigravity CLI's modes (ACP session modes). */
export type AntigravityMode = "default" | "accept-edits" | "auto" | "plan";

/**
 * | Codex App | Antigravity CLI |
 * | Ask for approval | `default`: asks before edits and commands |
 * | Approve for me | `auto`: edits and safe commands go through, it asks before irreversible actions |
 * | Full Access | `auto`, and CCodex allows what it still asks about |
 * | Plan mode | `plan` |
 * `available`: the modes the session offers (none known yet: all).
 */
export function antigravityMode(settings: Pick<AntigravitySettings, "permissionMode" | "plan">, available?: readonly string[]): AntigravityMode {
  const offered = (mode: AntigravityMode) => !available?.length || available.includes(mode);
  if (settings.plan && offered("plan")) return "plan";
  if ((settings.permissionMode === "bypassPermissions" || settings.permissionMode === "auto") && offered("auto")) return "auto";
  return "default";
}

/** The chat's permissions and plan mode after the App changed its settings. */
export function nextPermissions(params: JsonObject, current: Pick<AntigravitySettings, "permissionMode" | "plan">): Pick<AntigravitySettings, "permissionMode" | "plan"> {
  return permissionSettings(params, current);
}

/** A chat's permissions as the App reads them back. */
export function appPermissions(settings: Pick<AntigravitySettings, "permissionMode" | "cwd">): CodexPermissions {
  return codexPermissions(settings.permissionMode, settings.cwd);
}

export interface PermissionOption {
  readonly optionId: string;
  readonly name?: string;
  readonly kind: string;
}

export type PermissionOutcome = { readonly outcome: "selected"; readonly optionId: string } | { readonly outcome: "cancelled" };

/** The App's approval decision as one of the options the CLI offered. */
export function permissionOutcome(decision: unknown, options: readonly PermissionOption[]): PermissionOutcome {
  const pick = (...kinds: string[]) => kinds.map((kind) => options.find((option) => option.kind === kind)).find(Boolean);
  const chosen = decision === "accept" ? pick("allow_once", "allow_always")
    // An object is stock's "accept, and remember" (an exec policy amendment): the session remembers.
    : decision === "acceptForSession" || (typeof decision === "object" && decision !== null) ? pick("allow_always", "allow_once")
    : decision === "decline" ? pick("reject_once", "reject_always")
    : undefined;
  return chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" };
}

/** The decision CCodex gives without asking: never-ask chats decline what needs approval; Full Access accepts. */
export function unaskedDecision(mode: PermissionChoice): "accept" | "decline" | undefined {
  if (mode === "dontAsk") return "decline";
  if (mode === "bypassPermissions") return "accept";
  return undefined;
}

/** The App's approval request for a tool call the CLI wants confirmed (shown on the call's item). */
export function approvalRequest(
  item: ThreadItem | undefined,
  context: { readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly cwd: string; readonly title: string; readonly startedAtMs: number },
): { readonly method: string; readonly params: JsonObject } {
  const base = { threadId: context.threadId, turnId: context.turnId, itemId: context.itemId, startedAtMs: context.startedAtMs };
  if (item?.type === "fileChange") {
    return { method: "item/fileChange/requestApproval", params: { ...base, reason: context.title || null, grantRoot: null } };
  }
  const command = item?.type === "commandExecution" && item.command ? item.command : context.title;
  return {
    method: "item/commandExecution/requestApproval",
    params: {
      kind: "command", ...base, environmentId: null, reason: null, command, cwd: context.cwd,
      commandActions: item?.type === "commandExecution" ? item.commandActions : [{ type: "unknown", command }],
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    },
  };
}
