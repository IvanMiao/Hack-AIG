import { FORGE_URL } from "./forgeClient";
import type { NemesisSpec } from "./spec";

export const ASSET_KINDS = ["sky", "portrait", "music", "voice"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** `files` maps stable names (`sky`, `portrait`, `p1`/`p2`, `intro`/`phase`/`taunt0`…) to absolute URLs. */
export interface AssetBundle { kind: AssetKind; files: Record<string, string> }

const ASSET_TIMEOUT_MS = 90_000;

/** Proof the Worker handed out this code (returned by /forge and /nemesis/:code); asset generation refuses without it. */
export type ForgeToken = string;

/** Fetch a forge token for a code the Worker already knows (a bound nightmare summoned without going through /forge). */
export async function fetchForgeToken(code: string): Promise<ForgeToken> {
  const response = await fetch(`${FORGE_URL}/nemesis/${encodeURIComponent(code)}`);
  if (!response.ok) throw new Error(`nemesis ${response.status}`);
  const data = (await response.json()) as { token?: ForgeToken };
  if (!data.token) throw new Error("nemesis response carried no token");
  return data.token;
}

/** The voice request carries the exact lines this client shows as subtitles, so the audio is never an older self's script. */
export async function requestAsset(spec: Pick<NemesisSpec, "code" | "voice">, token: ForgeToken, kind: AssetKind): Promise<AssetBundle> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_TIMEOUT_MS);
  try {
    const voice = kind === "voice" ? { designPrompt: spec.voice.designPrompt, lines: spec.voice.lines } : undefined;
    const response = await fetch(`${FORGE_URL}/forge/asset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: spec.code, kind, voice, token }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`asset ${kind} ${response.status}`);
    const manifest = (await response.json()) as { kind: AssetKind; files: Record<string, string> };
    const files = Object.fromEntries(Object.entries(manifest.files).map(([name, path]) => [name, `${FORGE_URL}${path}`]));
    return { kind, files };
  } finally {
    clearTimeout(timer);
  }
}

export interface AssetListener {
  onReady(bundle: AssetBundle): void;
  onFail(kind: AssetKind, error: unknown): void;
}

/** Fire the generations in parallel; each settles independently so the ritual can reveal them as they land. */
export function requestAllAssets(spec: Pick<NemesisSpec, "code" | "voice">, token: ForgeToken, listener: AssetListener, kinds: readonly AssetKind[] = ASSET_KINDS): Promise<void> {
  return Promise.all(kinds.map((kind) =>
    requestAsset(spec, token, kind).then(listener.onReady, (error: unknown) => listener.onFail(kind, error)),
  )).then(() => undefined);
}
