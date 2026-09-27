import type { Lineage } from "./share";
import { checkInvariants, getFallbackSpec, type NemesisSpec } from "./spec";

const DEPLOYED_FORGE_URL = "https://nemesis-forge.ymiao.workers.dev";
export const FORGE_URL = (import.meta.env.VITE_FORGE_URL as string | undefined) ?? (import.meta.env.PROD ? DEPLOYED_FORGE_URL : "/api");
const FORGE_TIMEOUT_MS = 20_000;

export interface ForgeResponse { spec: NemesisSpec; repairs: string[]; cached: boolean; source: "gemini" | "fallback"; lineage?: Partial<Lineage>; token?: string }

/** Summon via the Worker; any failure or timeout falls back to a bundled nightmare so the demo never stalls. */
export async function forge(incantation: string): Promise<ForgeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORGE_TIMEOUT_MS);
  try {
    const response = await fetch(`${FORGE_URL}/forge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incantation }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`forge ${response.status}`);
    const data = (await response.json()) as ForgeResponse;
    const problems = checkInvariants(data.spec);
    if (problems.length > 0) throw new Error(`unfair spec: ${problems.join("; ")}`);
    return data;
  } catch (error) {
    console.warn("[forge] falling back", error);
    return { spec: getFallbackSpec(), repairs: [], cached: false, source: "fallback" };
  } finally {
    clearTimeout(timer);
  }
}
