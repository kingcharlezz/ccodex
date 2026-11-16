// An Antigravity chat as the Codex protocol's objects: its thread row and the settings the App reads back. All pure.
import { requestedModel, type JsonObject, type Thread, type Turn } from "../protocol/codex.js";
import { ANTIGRAVITY_PROVIDER, antigravityModelId, isAntigravityModel } from "./models.js";
import { appPermissions, nextPermissions, type AntigravitySettings } from "./permissions.js";
import { previewOf, type ThreadRecord } from "./store.js";

export const settingsOf = (record: ThreadRecord): AntigravitySettings =>
  ({ cwd: record.cwd, model: record.model, effort: record.effort, permissionMode: record.permissionMode, plan: record.plan });

/** The thread as stock lists one (`modelProvider: "antigravity"`). */
export function antigravityThread(record: ThreadRecord, prefix: string, options: { readonly status: Thread["status"]; readonly ephemeral?: boolean; readonly turns?: Turn[] }): Thread {
  return {
    id: record.id,
    environments: [{ environmentId: "local", cwd: record.cwd, runtimeWorkspaceRoots: [record.cwd] }],
    extra: null,
    sessionId: record.id,
    forkedFromId: record.forkedFromId,
    parentThreadId: null,
    preview: previewOf(record),
    ephemeral: options.ephemeral ?? false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: ANTIGRAVITY_PROVIDER,
    model: `${prefix}${record.model}`,
    reasoningEffort: record.effort,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    recencyAt: record.updatedAt,
    status: options.status,
    path: null,
    cwd: record.cwd,
    cliVersion: "antigravity-cli",
    originator: null,
    source: "vscode",
    canAcceptDirectInput: true,
    threadSource: "user",
    agentNickname: null,
    agentRole: null,
    gitInfo: { sha: null, branch: null, originUrl: null },
    name: record.name,
    daybreakEnabled: null,
    turns: options.turns ?? [],
  };
}

/** Common fields of thread/start|resume|fork responses. */
export function settingsResponse(settings: AntigravitySettings, prefix: string): JsonObject {
  const permissions = appPermissions(settings);
  return {
    model: `${prefix}${settings.model}`,
    modelProvider: ANTIGRAVITY_PROVIDER,
    serviceTier: null,
    disabledPluginIds: [],
    cwd: settings.cwd,
    runtimeWorkspaceRoots: [settings.cwd],
    instructionSources: [],
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    sandbox: permissions.sandboxPolicy,
    activePermissionProfile: permissions.activePermissionProfile,
    reasoningEffort: settings.effort,
    multiAgentMode: "explicitRequestOnly",
  };
}

/** Stock's `ThreadSettings` (thread/settings/updated, a resume's collaboration mode). */
export function threadSettings(settings: AntigravitySettings, prefix: string): JsonObject {
  const response = settingsResponse(settings, prefix);
  return {
    disabledPluginIds: [],
    cwd: settings.cwd,
    approvalPolicy: response.approvalPolicy,
    approvalsReviewer: response.approvalsReviewer,
    sandboxPolicy: response.sandbox,
    activePermissionProfile: response.activePermissionProfile,
    model: response.model,
    modelProvider: ANTIGRAVITY_PROVIDER,
    serviceTier: null,
    effort: settings.effort,
    summary: null,
    collaborationMode: { mode: settings.plan ? "plan" : "default", settings: { model: response.model, reasoning_effort: settings.effort, developer_instructions: null } },
    multiAgentMode: "explicitRequestOnly",
    personality: null,
  };
}

/** The chat's settings after a request that may change them (thread/start, turn/start, settings/update). */
export function settingsFrom(params: JsonObject, current: AntigravitySettings, prefix: string): AntigravitySettings {
  const requested = requestedModel(params);
  return {
    cwd: params.cwd ?? current.cwd,
    model: isAntigravityModel(requested, prefix) ? antigravityModelId(requested, prefix) : current.model,
    effort: params.effort ?? params.collaborationMode?.settings?.reasoning_effort ?? current.effort,
    ...nextPermissions(params, current),
  };
}

/** A model of another provider asked of an Antigravity chat (or an Antigravity model of another provider's chat). */
export function otherProviderRequested(params: JsonObject, prefix: string): boolean {
  const requested = requestedModel(params);
  return typeof requested === "string" && requested !== "" && !isAntigravityModel(requested, prefix);
}

export const SWITCH_UNSUPPORTED = "A chat with messages can't switch to or from Antigravity yet: start a new chat and pick the model before its first message.";
