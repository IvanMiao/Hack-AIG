// Runs the Worker asset pipeline (Nano Banana sky/portrait, Lyria music, Gradium voice) locally against a bundled or forged spec.
// Usage: GEMINI_API_KEY=... GRADIUM_API_KEY=... npx vite-node scripts/assets-live.ts [sky|portrait|music|voice|all] [code]
import { mkdirSync, writeFileSync } from "node:fs";
import { getFallbackSpec } from "../src/spec";
import { ASSET_KINDS, buildAsset, isAssetKind, type AssetKind } from "../worker/src/assets";
import type { Env } from "../worker/src/env";

const blobs = new Map<string, { value: ArrayBuffer | string; metadata?: unknown }>();
const memoryKv = {
  get: async (key: string) => { const hit = blobs.get(key); return hit && typeof hit.value === "string" ? JSON.parse(hit.value) : null; },
  getWithMetadata: async (key: string) => { const hit = blobs.get(key); return { value: hit?.value ?? null, metadata: hit?.metadata ?? null }; },
  put: async (key: string, value: ArrayBuffer | string, options?: { metadata?: unknown }) => { blobs.set(key, { value, metadata: options?.metadata }); },
} as unknown as KVNamespace;

const env: Env = {
  NEMESIS_KV: memoryKv,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
  GRADIUM_API_KEY: process.env.GRADIUM_API_KEY ?? "",
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  GEMINI_TEXT_MODEL: "gemini-3.8-flash",
  GEMINI_IMAGE_MODEL: "gemini-3.1-flash-image",
  MUSIC_PROVIDER: (process.env.MUSIC_PROVIDER as Env["MUSIC_PROVIDER"] | undefined) ?? "lyria",
  ALLOWED_ORIGINS: "",
};

const which = process.argv[2] ?? "all";
const kinds: AssetKind[] = which === "all" ? [...ASSET_KINDS] : isAssetKind(which) ? [which] : [];
if (kinds.length === 0) { console.error("kind must be sky|portrait|music|voice|all"); process.exit(1); }
const spec = getFallbackSpec();
mkdirSync("smoke-out/assets", { recursive: true });

await Promise.all(kinds.map(async (kind) => {
  const start = Date.now();
  try {
    const manifest = await buildAsset(env, spec, kind);
    for (const [name, path] of Object.entries(manifest.files)) {
      const stored = blobs.get(`blob:${spec.code}:${path.split("/").pop()}`);
      const meta = stored?.metadata as { contentType: string } | undefined;
      const bytes = stored?.value instanceof ArrayBuffer ? stored.value.byteLength : 0;
      const ext = meta?.contentType.includes("png") ? "png" : meta?.contentType.includes("ogg") ? "ogg" : meta?.contentType.includes("mp") ? "mp3" : "bin";
      if (stored?.value instanceof ArrayBuffer) writeFileSync(`smoke-out/assets/${kind}-${name}.${ext}`, Buffer.from(stored.value));
      console.log(`OK   ${kind}/${name} ${meta?.contentType} ${(bytes / 1024).toFixed(0)}KB`);
    }
    console.log(`DONE ${kind} in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (error) {
    process.exitCode = 1;
    console.log(`FAIL ${kind} (${((Date.now() - start) / 1000).toFixed(1)}s): ${error instanceof Error ? error.message : String(error)}`);
  }
}));
