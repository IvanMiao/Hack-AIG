// Runs the real Worker forge pipeline (Gemini → ajv → normalize → invariants) locally with an in-memory KV.
// Usage: GEMINI_API_KEY=... npx vite-node scripts/forge-live.ts "an iron knight who drowned his daughter and hates fire"
import { writeFileSync, mkdirSync } from "node:fs";
import type { Env } from "../worker/src/env";
import { forgeNemesis } from "../worker/src/forge";

const store = new Map<string, string>();
const memoryKv = {
  get: async (key: string) => { const value = store.get(key); return value ? JSON.parse(value) : null; },
  put: async (key: string, value: string) => { store.set(key, value); },
} as unknown as KVNamespace;

const env: Env = {
  NEMESIS_KV: memoryKv,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
  GRADIUM_API_KEY: process.env.GRADIUM_API_KEY ?? "",
  GEMINI_TEXT_MODEL: process.env.GEMINI_TEXT_MODEL ?? "gemini-3.8-flash",
  GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image",
  MUSIC_PROVIDER: "lyria",
  ALLOWED_ORIGINS: "",
};

const incantation = process.argv[2] ?? "an iron knight who drowned his daughter and hates fire";
const start = Date.now();
const result = await forgeNemesis(env, incantation).catch((error: Error) => { console.error(error.message); process.exit(1); });
mkdirSync("smoke-out", { recursive: true });
writeFileSync(`smoke-out/forge-${result.spec.code}.json`, JSON.stringify(result.spec, null, 2));
console.log(`forged ${result.spec.identity.name} — ${result.spec.identity.title} in ${((Date.now() - start) / 1000).toFixed(1)}s`);
console.log(`repairs: ${result.repairs.length ? result.repairs.join("; ") : "none"}`);
console.log(`intro: ${result.spec.voice.lines.intro}`);
console.log(`phases: ${result.spec.phases.map((p) => `${p.hpThreshold}:[${p.moves.map((m) => m.type).join(",")}]`).join(" ")}`);
