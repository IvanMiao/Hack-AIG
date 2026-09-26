import Ajv, { type JSONSchemaType } from "ajv";
import {
  ELEMENTS, MOVE_TYPES, PHASE_RULES, SILHOUETTES, TEMPERS, WEAKNESS_TRIGGERS,
  type ForgeDraft, type Move, type Phase, type VoiceLines,
} from "./types";

const hexColor = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } as const;

const moveSchema: JSONSchemaType<Move> = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...MOVE_TYPES] },
    telegraphMs: { type: "number" },
    damage: { type: "number" },
    scale: { type: "number" },
    count: { type: "number" },
    followUp: { type: "string", enum: [...MOVE_TYPES, null], nullable: true },
  },
  required: ["type", "telegraphMs", "damage", "scale", "count"],
  additionalProperties: false,
};

const phaseSchema: JSONSchemaType<Phase> = {
  type: "object",
  properties: {
    hpThreshold: { type: "number" },
    moves: { type: "array", items: moveSchema },
    rule: { type: "string", enum: [...PHASE_RULES] },
  },
  required: ["hpThreshold", "moves", "rule"],
  additionalProperties: false,
};

const voiceLinesSchema: JSONSchemaType<VoiceLines> = {
  type: "object",
  properties: {
    intro: { type: "string" },
    phase: { type: "string" },
    taunt: { type: "array", items: { type: "string" } },
    playerDeath: { type: "array", items: { type: "string" } },
    defeat: { type: "string" },
  },
  required: ["intro", "phase", "taunt", "playerDeath", "defeat"],
  additionalProperties: false,
};

/** Shared by ajv (validation) and Gemini (responseSchema). Bounds are enforced by normalize, not here. */
export const forgeDraftSchema: JSONSchemaType<ForgeDraft> = {
  type: "object",
  properties: {
    identity: {
      type: "object",
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        incantation: { type: "string" },
        silhouette: { type: "string", enum: [...SILHOUETTES] },
        element: { type: "string", enum: [...ELEMENTS] },
        temper: { type: "string", enum: [...TEMPERS] },
        palette: { type: "array", items: [hexColor, hexColor, hexColor], minItems: 3, maxItems: 3 },
      },
      required: ["name", "title", "incantation", "silhouette", "element", "temper", "palette"],
      additionalProperties: false,
    },
    stats: {
      type: "object",
      properties: {
        maxHp: { type: "number" },
        poise: { type: "number" },
        aggression: { type: "number" },
        playerDamage: { type: "number", nullable: true },
      },
      required: ["maxHp", "poise", "aggression"],
      additionalProperties: false,
    },
    phases: { type: "array", items: phaseSchema },
    weakness: {
      type: "object",
      properties: {
        trigger: { type: "string", enum: [...WEAKNESS_TRIGGERS] },
        multiplier: { type: "number" },
      },
      required: ["trigger", "multiplier"],
      additionalProperties: false,
    },
    arenaTheme: { type: "string" },
    voice: {
      type: "object",
      properties: { designPrompt: { type: "string" }, lines: voiceLinesSchema },
      required: ["designPrompt", "lines"],
      additionalProperties: false,
    },
    music: {
      type: "object",
      properties: {
        p1Prompt: { type: "string" },
        p2Prompt: { type: "string" },
        bpm: { type: "number" },
      },
      required: ["p1Prompt", "p2Prompt", "bpm"],
      additionalProperties: false,
    },
    art: {
      type: "object",
      properties: {
        styleAnchor: { type: "string" },
        accentHex: hexColor,
        skyPrompt: { type: "string" },
        portraitPrompt: { type: "string" },
      },
      required: ["styleAnchor", "accentHex", "skyPrompt", "portraitPrompt"],
      additionalProperties: false,
    },
  },
  required: ["identity", "stats", "phases", "weakness", "arenaTheme", "voice", "music", "art"],
  additionalProperties: false,
};

const ajv = new Ajv({ allErrors: true, removeAdditional: "all" });
export const validateForgeDraft = ajv.compile(forgeDraftSchema);

export type DraftValidation = { ok: true; draft: ForgeDraft } | { ok: false; errors: string[] };

export function parseForgeDraft(input: unknown): DraftValidation {
  if (validateForgeDraft(input)) return { ok: true, draft: input };
  const errors = (validateForgeDraft.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
  return { ok: false, errors };
}
