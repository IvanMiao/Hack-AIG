import { FALLBACK_SPECS, LIMITS, type NemesisSpec, type Voice, type VoiceLines } from "../../src/spec";
import type { Env } from "./env";
import { generateImage, generateMusicClip, type MediaBlob } from "./gemini";
import { designVoice, discardVoice, synthesize, VOICE_RENDER_VERSION } from "./gradium";

export const ASSET_KINDS = ["sky", "portrait", "music", "voice"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const isAssetKind = (value: unknown): value is AssetKind => ASSET_KINDS.includes(value as AssetKind);

/** `files` maps a stable name (e.g. `intro`, `p1`, `sky`) to a Worker-relative path the client prefixes with its forge URL. */
export interface AssetManifest { kind: AssetKind; files: Record<string, string>; cached: boolean }

const BLOB_TTL_SECONDS = 60 * 60 * 24 * 30;
const assetPath = (code: string, name: string) => `/asset/${code}/${name}`;
const blobKey = (code: string, name: string) => `blob:${code}:${name}`;
const manifestKey = (code: string, kind: AssetKind) => `asset:${code}:${kind}`;

export async function loadSpecByCode(env: Env, code: string): Promise<NemesisSpec | null> {
  const stored = await env.NEMESIS_KV.get<NemesisSpec>(`code:${code}`, "json");
  return stored ?? FALLBACK_SPECS.find((spec) => spec.code === code) ?? null;
}

export async function readBlob(env: Env, code: string, name: string): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const { value, metadata } = await env.NEMESIS_KV.getWithMetadata<{ contentType: string }>(blobKey(code, name), "arrayBuffer");
  if (!value) return null;
  return { bytes: value, contentType: metadata?.contentType ?? "application/octet-stream" };
}

async function storeBlob(env: Env, code: string, name: string, blob: MediaBlob): Promise<string> {
  await env.NEMESIS_KV.put(blobKey(code, name), blob.bytes.buffer as ArrayBuffer, {
    expirationTtl: BLOB_TTL_SECONDS,
    metadata: { contentType: blob.mimeType },
  });
  return assetPath(code, name);
}

async function buildSky(env: Env, spec: NemesisSpec): Promise<Record<string, string>> {
  const prompt = `Seamless equirectangular 360 panorama, horizon at the vertical center, no ground objects: ${spec.art.skyPrompt}. ${spec.art.styleAnchor}`;
  return { sky: await storeBlob(env, spec.code, "sky", await generateImage(env, prompt, "16:9")) };
}

async function buildPortrait(env: Env, spec: NemesisSpec): Promise<Record<string, string>> {
  const prompt = `${spec.art.portraitPrompt}, named ${spec.identity.name}. ${spec.art.styleAnchor}. Centered, dramatic, on a pure black background.`;
  return { portrait: await storeBlob(env, spec.code, "portrait", await generateImage(env, prompt, "3:4")) };
}

async function musicClip(env: Env, prompt: string): Promise<MediaBlob> {
  const fullPrompt = `Instrumental boss battle loop, no vocals, dark fantasy, seamless loop: ${prompt}`;
  if (env.MUSIC_PROVIDER === "elevenlabs" && env.ELEVENLABS_API_KEY) {
    const response = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY },
      body: JSON.stringify({ model_id: "music_v2", prompt: fullPrompt, music_length_ms: 30_000 }),
    });
    if (!response.ok) throw new Error(`elevenlabs music ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return { mimeType: "audio/mpeg", bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  return generateMusicClip(env, fullPrompt);
}

async function buildMusic(env: Env, spec: NemesisSpec): Promise<Record<string, string>> {
  const [p1, p2] = await Promise.all([musicClip(env, spec.music.p1Prompt), musicClip(env, spec.music.p2Prompt)]);
  const [p1Path, p2Path] = await Promise.all([storeBlob(env, spec.code, "music-p1", p1), storeBlob(env, spec.code, "music-p2", p2)]);
  return { p1: p1Path, p2: p2Path };
}

/** Every spoken line the fight can trigger, keyed the way the client looks them up. */
export function voiceLineEntries(spec: Pick<NemesisSpec, "voice">): Array<[name: string, text: string]> {
  const { lines } = spec.voice;
  return [
    ["intro", lines.intro],
    ["phase", lines.phase],
    ...lines.taunt.map((text, i): [string, string] => [`taunt${i}`, text]),
    ...lines.playerDeath.map((text, i): [string, string] => [`playerDeath${i}`, text]),
    ["defeat", lines.defeat],
  ];
}

/** Gradium allows 2 concurrent TTS sessions per key, so lines are synthesized through a 2-wide pool. */
const TTS_CONCURRENCY = 2;

async function mapPooled<T, R>(items: readonly T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

/** The text the client will put on screen; the request may carry it so the audio is synthesized from exactly those words. */
export type VoiceScript = Pick<Voice, "designPrompt" | "lines">;

const isLine = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= LIMITS.lineLength.max;
const isLineList = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length >= 1 && value.length <= max && value.every(isLine);

export function parseVoiceScript(input: unknown): VoiceScript | null {
  if (!input || typeof input !== "object") return null;
  const { designPrompt, lines } = input as { designPrompt?: unknown; lines?: unknown };
  if (typeof designPrompt !== "string" || !lines || typeof lines !== "object") return null;
  const { intro, phase, taunt, playerDeath, defeat } = lines as Partial<Record<keyof VoiceLines, unknown>>;
  if (!isLine(intro) || !isLine(phase) || !isLine(defeat)) return null;
  if (!isLineList(taunt, LIMITS.taunts.max) || !isLineList(playerDeath, LIMITS.playerDeathLines.max)) return null;
  return { designPrompt: designPrompt.slice(0, 300), lines: { intro, phase, taunt, playerDeath, defeat } };
}

async function scriptHash(voice: VoiceScript): Promise<string> {
  const text = JSON.stringify([VOICE_RENDER_VERSION, voice.designPrompt, ...voiceLineEntries({ voice })]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildVoice(env: Env, code: string, voice: VoiceScript, hash: string): Promise<Record<string, string>> {
  const voiceId = await designVoice(env, `${voice.designPrompt}. Speaks English.`);
  try {
    const entries = await mapPooled(voiceLineEntries({ voice }), TTS_CONCURRENCY, async ([name, text]): Promise<[string, string]> =>
      [name, await storeBlob(env, code, `voice-${hash}-${name}`, await synthesize(env, voiceId, text))]);
    return Object.fromEntries(entries);
  } finally {
    await discardVoice(env, voiceId);
  }
}

const builders: Record<Exclude<AssetKind, "voice">, (env: Env, spec: NemesisSpec) => Promise<Record<string, string>>> = {
  sky: buildSky,
  portrait: buildPortrait,
  music: buildMusic,
};

/**
 * Voice is keyed by the script it speaks, not just the code: a boss whose lines changed (grudge, re-authored fallback,
 * client/worker skew) gets fresh audio instead of the words of an older self. Needs no stored spec, only the code.
 */
export async function buildVoiceAsset(env: Env, code: string, voice: VoiceScript): Promise<AssetManifest> {
  const hash = await scriptHash(voice);
  const key = `${manifestKey(code, "voice")}:${hash}`;
  const cached = await env.NEMESIS_KV.get<Record<string, string>>(key, "json");
  if (cached) return { kind: "voice", files: cached, cached: true };
  const files = await buildVoice(env, code, voice, hash);
  await env.NEMESIS_KV.put(key, JSON.stringify(files), { expirationTtl: BLOB_TTL_SECONDS });
  return { kind: "voice", files, cached: false };
}

/** Generate (or reuse) one asset bundle for a forged boss. Kinds are independent so the client can fetch all four in parallel. */
export async function buildAsset(env: Env, spec: NemesisSpec, kind: AssetKind): Promise<AssetManifest> {
  if (kind === "voice") return buildVoiceAsset(env, spec.code, spec.voice);
  const key = manifestKey(spec.code, kind);
  const cached = await env.NEMESIS_KV.get<Record<string, string>>(key, "json");
  if (cached) return { kind, files: cached, cached: true };
  const files = await builders[kind](env, spec);
  await env.NEMESIS_KV.put(key, JSON.stringify(files), { expirationTtl: BLOB_TTL_SECONDS });
  return { kind, files, cached: false };
}
