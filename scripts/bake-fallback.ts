// Bakes the bound nightmares' assets (Nano Banana sky/portrait, Lyria music, Gradium voice) into the build so they play with zero network.
// Writes public/fallback/<code>/* and src/fallbackAssets.json; kinds already baked are skipped unless --force.
// Usage: GEMINI_API_KEY=... GRADIUM_API_KEY=... npx vite-node scripts/bake-fallback.ts [all|<code>] [sky|portrait|music|voice ...] [--force]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FALLBACK_SPECS, type NemesisSpec } from "../src/spec";
import { ASSET_KINDS, buildAsset, isAssetKind, type AssetKind } from "../worker/src/assets";
import type { Env } from "../worker/src/env";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DIR = join(ROOT, "public/fallback");
const MANIFEST = join(ROOT, "src/fallbackAssets.json");

type Manifest = Record<string, Partial<Record<AssetKind, Record<string, string>>>>;

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
  GEMINI_TEXT_MODEL: process.env.GEMINI_TEXT_MODEL ?? "gemini-3.8-flash",
  GEMINI_IMAGE_MODEL: process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image",
  MUSIC_PROVIDER: (process.env.MUSIC_PROVIDER as Env["MUSIC_PROVIDER"] | undefined) ?? "lyria",
  ALLOWED_ORIGINS: "",
};

const extensionFor = (contentType: string): string => {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("ogg")) return "ogg";
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mp")) return "mp3";
  return "bin";
};

const args = process.argv.slice(2);
const force = args.includes("--force");
const positional = args.filter((arg) => !arg.startsWith("--"));
const codeArg = positional.find((arg) => !isAssetKind(arg)) ?? "all";
const kindArgs = positional.filter(isAssetKind);
const kinds: AssetKind[] = kindArgs.length > 0 ? kindArgs : [...ASSET_KINDS];

const specs: NemesisSpec[] = codeArg === "all" ? FALLBACK_SPECS : FALLBACK_SPECS.filter((spec) => spec.code === codeArg);
if (specs.length === 0) { console.error(`no bound nightmare with code ${codeArg}; known: ${FALLBACK_SPECS.map((s) => s.code).join(", ")}`); process.exit(1); }
if (!env.GEMINI_API_KEY) { console.error("GEMINI_API_KEY is required"); process.exit(1); }
if (kinds.includes("voice") && !env.GRADIUM_API_KEY) { console.error("GRADIUM_API_KEY is required for voice"); process.exit(1); }

const manifest: Manifest = existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest) : {};
// Codes that no longer exist in fallback.ts are dropped so the manifest never points at a nightmare the build cannot summon.
for (const code of Object.keys(manifest)) {
  if (!FALLBACK_SPECS.some((spec) => spec.code === code)) {
    delete manifest[code];
    rmSync(join(PUBLIC_DIR, code), { recursive: true, force: true });
    console.log(`DROP ${code}: no longer bundled`);
  }
}

const saveManifest = () => writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

async function bake(spec: NemesisSpec, kind: AssetKind): Promise<void> {
  const entry = (manifest[spec.code] ??= {});
  if (entry[kind] && !force) { console.log(`SKIP ${spec.code}/${kind}: already baked (use --force)`); return; }
  const start = Date.now();
  const built = await buildAsset(env, spec, kind);
  const outDir = join(PUBLIC_DIR, spec.code);
  mkdirSync(outDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const [name, path] of Object.entries(built.files)) {
    const stored = blobs.get(`blob:${spec.code}:${path.split("/").pop()}`);
    if (!stored || !(stored.value instanceof ArrayBuffer)) throw new Error(`${kind}/${name} produced no bytes`);
    const contentType = (stored.metadata as { contentType?: string } | undefined)?.contentType ?? "application/octet-stream";
    const fileName = `${kind}-${name}.${extensionFor(contentType)}`;
    writeFileSync(join(outDir, fileName), Buffer.from(stored.value));
    files[name] = `fallback/${spec.code}/${fileName}`;
    console.log(`OK   ${spec.code}/${kind}/${name} ${contentType} ${(stored.value.byteLength / 1024).toFixed(0)}KB`);
  }
  entry[kind] = files;
  saveManifest();
  console.log(`DONE ${spec.code}/${kind} in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

saveManifest();
for (const spec of specs) {
  // Kinds run in parallel per boss; bosses run in sequence to stay under the partner APIs' concurrency limits.
  await Promise.all(kinds.map((kind) => bake(spec, kind).catch((error: unknown) => {
    process.exitCode = 1;
    console.log(`FAIL ${spec.code}/${kind}: ${error instanceof Error ? error.message : String(error)}`);
  })));
}
