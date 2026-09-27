import { FORGE_URL } from "./forgeClient";
import type { Lineage } from "./share";
import { checkInvariants, FALLBACK_SPECS, type NemesisSpec } from "./spec";

const LOOKUP_TIMEOUT_MS = 12_000;

/** `token` is the Worker's forge token for the code; absent when a bound nightmare resolved locally. */
export interface HuntedNemesis { spec: NemesisSpec; lineage: Lineage; token?: string }

/** Merge the KV counters with the spec's own generation, which is the one GRUDGE actually advances. */
export const lineageFor = (spec: NemesisSpec, counters?: Partial<Lineage> | null): Lineage => ({
  gen: spec.lineage.gen,
  kills: counters?.kills ?? spec.lineage.kills,
  victories: counters?.victories ?? 0,
});

/**
 * Resolve a shared code to its latest spec. Bound nightmares resolve locally; anything else asks the Worker.
 * Returns null when nothing answers to the code; throws when the rift itself is unreachable.
 */
export async function fetchNemesis(code: string): Promise<HuntedNemesis | null> {
  const bundled = FALLBACK_SPECS.find((spec) => spec.code === code);
  if (bundled) {
    const spec = structuredClone(bundled);
    const counters = await fetchLineage(code).catch(() => null);
    return { spec, lineage: lineageFor(spec, counters) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(`${FORGE_URL}/nemesis/${encodeURIComponent(code)}`, { signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`nemesis ${response.status}`);
    const data = (await response.json()) as { spec: NemesisSpec; lineage?: Partial<Lineage>; token?: string };
    const problems = checkInvariants(data.spec);
    if (problems.length > 0) throw new Error(`unfair spec: ${problems.join("; ")}`);
    return { spec: data.spec, lineage: lineageFor(data.spec, data.lineage), token: data.token };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLineage(code: string): Promise<Partial<Lineage>> {
  const response = await fetch(`${FORGE_URL}/lineage/${encodeURIComponent(code)}`);
  if (!response.ok) throw new Error(`lineage ${response.status}`);
  return (await response.json()) as Partial<Lineage>;
}

/** Best-effort: the fight already happened, so a failed write only costs the counter on the share card. */
export async function recordOutcome(code: string, outcome: "kill" | "victory"): Promise<Partial<Lineage> | null> {
  try {
    const response = await fetch(`${FORGE_URL}/lineage/${encodeURIComponent(code)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome }),
    });
    if (!response.ok) throw new Error(`lineage ${response.status}`);
    return (await response.json()) as Partial<Lineage>;
  } catch (error) {
    console.warn(`[lineage] ${outcome} not recorded`, error);
    return null;
  }
}
