import type { Env } from "./env";

export interface Lineage { gen: number; kills: number; victories: number }

const key = (code: string) => `lineage:${code.toUpperCase()}`;

export async function getLineage(env: Env, code: string): Promise<Lineage> {
  return (await env.NEMESIS_KV.get<Lineage>(key(code), "json")) ?? { gen: 1, kills: 0, victories: 0 };
}

/** KV is eventually consistent, so counts are approximate — fine for a chain-letter kill counter. */
export async function recordOutcome(env: Env, code: string, outcome: "kill" | "victory"): Promise<Lineage> {
  const current = await getLineage(env, code);
  const next: Lineage = outcome === "kill"
    ? { ...current, kills: current.kills + 1 }
    : { ...current, victories: current.victories + 1 };
  await env.NEMESIS_KV.put(key(code), JSON.stringify(next));
  return next;
}
