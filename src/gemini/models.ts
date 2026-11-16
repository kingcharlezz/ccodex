// Gemini's models as the App's model picker lists them. All pure.
import type { JsonObject } from "../protocol/codex.js";

/** A model as the Gemini CLI names it in a session (`models.availableModels` of ACP's `session/new`). */
export interface GeminiModel {
  readonly modelId: string;
  readonly name?: string | null;
  readonly description?: string | null;
}

export const GEMINI_PROVIDER = "gemini";

/** The model the Gemini CLI routes with when none is picked. */
export const AUTO_MODEL = "auto";

/**
 * What the Gemini CLI offers every login, until a session of this machine's CLI has told its own list (preview
 * models depend on the account).
 */
export const FALLBACK_MODELS: readonly GeminiModel[] = [
  { modelId: AUTO_MODEL, name: "Auto", description: "Gemini CLI picks the model for each request." },
  { modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  { modelId: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { modelId: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash-Lite" },
];

/** `gemini-2.5-flash-lite` → `Gemini 2.5 Flash Lite`. */
export function geminiModelLabel(modelId: string): string {
  if (modelId === AUTO_MODEL) return "Gemini (auto)";
  return modelId.split("-").map((part) => /^\d/u.test(part) ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

/** The picker's name of a model: the CLI's own, said to be Gemini's. */
export function geminiDisplayName(model: GeminiModel): string {
  if (model.modelId === AUTO_MODEL) return "Gemini (auto)";
  const name = model.name?.trim() || geminiModelLabel(model.modelId);
  return /gemini/iu.test(name) ? name : `Gemini ${name}`;
}

export const isGeminiModel = (model: unknown, prefix: string): model is string => typeof model === "string" && model.startsWith(prefix);

/** The CLI's id of a picker value (`gemini:gemini-2.5-pro` → `gemini-2.5-pro`). */
export const geminiModelId = (model: string, prefix: string): string => model.slice(prefix.length);

/** A Gemini model as stock lists a model. Gemini takes no reasoning effort over ACP, so it offers none. */
export function mapGeminiModel(model: GeminiModel, prefix: string): JsonObject {
  const id = `${prefix}${model.modelId}`;
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    modelSpecialty: null,
    multiAgentVersion: null,
    displayName: geminiDisplayName(model),
    description: model.description?.trim() || `${geminiModelLabel(model.modelId)}, run by the Gemini CLI.`,
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: false,
  };
}

/** The models to list: the CLI's own once known, without repeats, `auto` always among them. */
export function listedModels(known: readonly GeminiModel[] | undefined): readonly GeminiModel[] {
  const models = known?.length ? known : FALLBACK_MODELS;
  const unique = [...new Map(models.filter((model) => model.modelId).map((model) => [model.modelId, model])).values()];
  return unique.some((model) => model.modelId === AUTO_MODEL) ? unique : [FALLBACK_MODELS[0]!, ...unique];
}
