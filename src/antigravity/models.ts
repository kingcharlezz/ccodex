// Antigravity's models as the App's model picker lists them. All pure.
//
// The Antigravity CLI names one model per reasoning effort (`gemini-4-carbon-low`, `…-medium`, `…-high`); the picker
// lists the model once (`antigravity:gemini-4-carbon`) with those efforts, and the effort picked chooses the CLI's id.
import type { JsonObject } from "../protocol/codex.js";

/** A model as the Antigravity CLI names it (`agy models`, or ACP's `session/new`). */
export interface CliModel {
  readonly modelId: string;
  readonly name?: string | null;
  readonly description?: string | null;
}

/** A picker model: one per CLI model, with the efforts the CLI has ids for (none: it takes no effort). */
export interface AntigravityModel {
  readonly id: string;
  readonly name: string;
  readonly efforts: readonly string[];
}

export const ANTIGRAVITY_PROVIDER = "antigravity";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_SUFFIX = new RegExp(`^(.+)-(${EFFORTS.join("|")})$`, "u");
/** The CLI's name of an effort variant: `Gemini 4 Carbon (Medium)`. */
const EFFORT_NAME = /\s*\((?:minimal|low|medium|high|xhigh|max)\)\s*$/iu;

const effortOrder = (effort: string) => EFFORTS.indexOf(effort as typeof EFFORTS[number]);

/** `agy models` output: one `<id>\t<name>` line a model (a line without a tab, such as its progress note, is none). */
export function parseModelList(text: string): CliModel[] {
  return text.split("\n").flatMap((line) => {
    const [modelId, name] = line.split("\t");
    return name !== undefined && modelId?.trim() ? [{ modelId: modelId.trim(), name: name.trim() }] : [];
  });
}

/** The CLI's models grouped into the picker's, in the CLI's order. */
export function groupModels(models: readonly CliModel[]): AntigravityModel[] {
  const groups = new Map<string, { name: string; efforts: string[] }>();
  for (const model of models) {
    const match = EFFORT_SUFFIX.exec(model.modelId);
    const id = match?.[1] ?? model.modelId;
    const group = groups.get(id) ?? { name: (model.name?.trim() || id).replace(EFFORT_NAME, ""), efforts: [] };
    if (match) group.efforts.push(match[2]!);
    groups.set(id, group);
  }
  return [...groups].map(([id, group]) => ({ id, name: group.name, efforts: [...new Set(group.efforts)].sort((left, right) => effortOrder(left) - effortOrder(right)) }));
}

/** The effort a model runs at when the chat picked none (or one the model lacks): medium where it has it. */
export const defaultEffort = (model: AntigravityModel): string | null =>
  model.efforts.includes("medium") ? "medium" : model.efforts[0] ?? null;

/** The CLI's id for a chat's model and effort; a model the list doesn't know is passed on as it is. */
export function cliModelId(models: readonly AntigravityModel[], model: string, effort: string | null): string {
  const known = models.find((candidate) => candidate.id === model);
  if (!known?.efforts.length) return model;
  return `${model}-${effort && known.efforts.includes(effort) ? effort : defaultEffort(known)}`;
}

/** The picker's name: the CLI's, said to be Antigravity's when the model is another maker's (Claude, GPT-OSS). */
export function antigravityDisplayName(model: AntigravityModel): string {
  return /gemini|orchestrator/iu.test(model.name) ? model.name : `${model.name} (Antigravity)`;
}

/** `gemini-4-carbon` → `Gemini 4 Carbon`, for a model the list doesn't know. */
export function antigravityModelLabel(model: string, models: readonly AntigravityModel[] = []): string {
  const known = models.find((candidate) => candidate.id === model);
  if (known) return antigravityDisplayName(known);
  return model.split("-").map((part) => /^\d/u.test(part) ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

export const isAntigravityModel = (model: unknown, prefix: string): model is string => typeof model === "string" && model.startsWith(prefix);

/** The model of a picker value (`antigravity:gemini-4-carbon` → `gemini-4-carbon`). */
export const antigravityModelId = (model: string, prefix: string): string => model.slice(prefix.length);

const EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  minimal: "Fastest responses with minimal reasoning.",
  low: "Faster responses with less reasoning.",
  medium: "Balanced reasoning effort.",
  high: "Deep reasoning for complex work.",
  xhigh: "Extra-high reasoning effort.",
  max: "Maximum available reasoning effort.",
};

/** A model as stock lists one. */
export function mapAntigravityModel(model: AntigravityModel, prefix: string): JsonObject {
  const id = `${prefix}${model.id}`;
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    modelSpecialty: null,
    multiAgentVersion: null,
    displayName: antigravityDisplayName(model),
    description: `${model.name}, run by the Antigravity CLI.`,
    hidden: false,
    supportedReasoningEfforts: model.efforts.map((reasoningEffort) => ({ reasoningEffort, description: EFFORT_DESCRIPTIONS[reasoningEffort] ?? `${reasoningEffort} reasoning effort.` })),
    defaultReasoningEffort: defaultEffort(model) ?? "medium",
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: false,
  };
}
