import { checkInvariants, forgeDraftSchema, normalizeDraft, parseForgeDraft, type ForgeDraft, type NemesisSpec } from "../../src/spec";
import type { Env } from "./env";
import { FORGE_SYSTEM_PROMPT, forgeUserPrompt } from "./forgePrompt";
import { generateStructured } from "./gemini";

export interface ForgeResult { spec: NemesisSpec; repairs: string[]; cached: boolean; source: "gemini" }

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Share codes are short, human-typeable and derived from the incantation so identical summons share a lineage. */
export const shareCodeFor = (hash: string) => hash.slice(0, 8).toUpperCase();

export async function forgeNemesis(env: Env, incantation: string): Promise<ForgeResult> {
  const normalizedIncantation = incantation.trim().toLowerCase().replace(/\s+/g, " ");
  const hash = await sha256Hex(normalizedIncantation);
  const cacheKey = `forge:${hash}`;

  const cached = await env.NEMESIS_KV.get<NemesisSpec>(cacheKey, "json");
  if (cached) return { spec: cached, repairs: [], cached: true, source: "gemini" };

  let draft: ForgeDraft | null = null;
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2 && !draft; attempt += 1) {
    const raw = await generateStructured<unknown>(env, {
      system: FORGE_SYSTEM_PROMPT,
      user: attempt === 0 ? forgeUserPrompt(incantation) : `${forgeUserPrompt(incantation)}\nPrevious attempt failed validation: ${lastErrors.join("; ")}. Fix it.`,
      schema: forgeDraftSchema,
    });
    const parsed = parseForgeDraft(raw);
    if (parsed.ok) draft = parsed.draft; else lastErrors = parsed.errors;
  }
  if (!draft) throw new Error(`gemini draft invalid: ${lastErrors.join("; ")}`);

  const { spec, repairs } = normalizeDraft(draft, shareCodeFor(hash));
  const problems = checkInvariants(spec);
  if (problems.length > 0) throw new Error(`invariants failed after normalize: ${problems.join("; ")}`);

  await env.NEMESIS_KV.put(cacheKey, JSON.stringify(spec), { expirationTtl: CACHE_TTL_SECONDS });
  await env.NEMESIS_KV.put(`code:${spec.code}`, JSON.stringify(spec), { expirationTtl: CACHE_TTL_SECONDS });
  return { spec, repairs, cached: false, source: "gemini" };
}
