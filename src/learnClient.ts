import { FORGE_URL } from "./forgeClient";
import { applyGrudge, checkInvariants, ruleGrudge, type Grudge, type NemesisSpec } from "./spec";
import type { DeathLog } from "./sim";

const LEARN_TIMEOUT_MS = 12_000;

export interface LearnResponse { spec: NemesisSpec; grudge: Grudge; source: "gemini" | "rule" | "local" }

/** Evolve the spec after a player death; any failure falls back to the local rule grudge so the demo never stalls. */
export async function learn(spec: NemesisSpec, log: DeathLog): Promise<LearnResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEARN_TIMEOUT_MS);
  try {
    const response = await fetch(`${FORGE_URL}/learn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: spec.code, deathLog: log }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`learn ${response.status}`);
    const data = (await response.json()) as { spec: NemesisSpec; grudge: Grudge; source: "gemini" | "rule" };
    const problems = checkInvariants(data.spec);
    if (problems.length > 0) throw new Error(`unfair spec: ${problems.join("; ")}`);
    return data;
  } catch (error) {
    console.warn("[learn] falling back", error);
    const next = applyGrudge(spec, ruleGrudge(spec, log));
    const grudge = next.grudges[next.grudges.length - 1] ?? { observation: "", patch: "" };
    return { spec: next, grudge, source: "local" };
  } finally {
    clearTimeout(timer);
  }
}
