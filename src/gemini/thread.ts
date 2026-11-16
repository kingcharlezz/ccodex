// A Gemini chat as the Codex protocol's objects: its thread row and the settings the App reads back. All pure.
import { requestedModel, type JsonObject, type Thread, type Turn } from "../protocol/codex.js";
import { GEMINI_PROVIDER, geminiModelId, isGeminiModel } from "./models.js";
import { appPermissions, nextPermissions, type GeminiSettings } from "./permissions.js";
import { previewOf, type ThreadRecord } from "./store.js";

export const settingsOf = (record: ThreadRecord): GeminiSettings =>
  ({ cwd: record.cwd, model: record.model, permissionMode: record.permissionMode, plan: record.plan });

/** The thread as stock lists one (`modelProvider: "gemini"`). */
export function geminiThread(record: ThreadRecord, prefix: string, options: { readonly status: Thread["status"]; readonly ephemeral?: boolean; readonly turns?: Turn[] }): Thread {
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
    modelProvider: GEMINI_PROVIDER,
    model: `${prefix}${record.model}`,
    reasoningEffort: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    recencyAt: record.updatedAt,
    status: options.status,
    path: null,
    cwd: record.cwd,
    cliVersion: "gemini-cli",
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
export function settingsResponse(settings: GeminiSettings, prefix: string): JsonObject {
  const permissions = appPermissions(settings);
  return {
    model: `${prefix}${settings.model}`,
    modelProvider: GEMINI_PROVIDER,
    serviceTier: null,
    disabledPluginIds: [],
    cwd: settings.cwd,
    runtimeWorkspaceRoots: [settings.cwd],
    instructionSources: [],
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    sandbox: permissions.sandboxPolicy,
    activePermissionProfile: permissions.activePermissionProfile,
    reasoningEffort: null,
    multiAgentMode: "explicitRequestOnly",
  };
}

/** Stock's `ThreadSettings` (thread/settings/updated, a resume's collaboration mode). */
export function threadSettings(settings: GeminiSettings, prefix: string): JsonObject {
  const response = settingsResponse(settings, prefix);
  return {
    disabledPluginIds: [],
    cwd: settings.cwd,
    approvalPolicy: response.approvalPolicy,
    approvalsReviewer: response.approvalsReviewer,
    sandboxPolicy: response.sandbox,
    activePermissionProfile: response.activePermissionProfile,
    model: response.model,
    modelProvider: GEMINI_PROVIDER,
    serviceTier: null,
    effort: null,
    summary: null,
    collaborationMode: { mode: settings.plan ? "plan" : "default", settings: { model: response.model, reasoning_effort: null, developer_instructions: null } },
    multiAgentMode: "explicitRequestOnly",
    personality: null,
  };
}

/** The chat's settings after a request that may change them (thread/start, turn/start, settings/update). */
export function settingsFrom(params: JsonObject, current: GeminiSettings, prefix: string): GeminiSettings {
  const requested = requestedModel(params);
  return {
    cwd: params.cwd ?? current.cwd,
    model: isGeminiModel(requested, prefix) ? geminiModelId(requested, prefix) : current.model,
    ...nextPermissions(params, current),
  };
}

/** A model of another provider asked of a Gemini chat (or a Gemini model of another provider's chat). */
export function otherProviderRequested(params: JsonObject, prefix: string): boolean {
  const requested = requestedModel(params);
  return typeof requested === "string" && requested !== "" && !isGeminiModel(requested, prefix);
}

export const SWITCH_UNSUPPORTED = "A chat with messages can't switch to or from Gemini yet: start a new chat and pick the model before its first message.";
