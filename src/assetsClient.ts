import { FORGE_URL } from "./forgeClient";
import type { NemesisSpec } from "./spec";

export const ASSET_KINDS = ["sky", "portrait", "music", "voice"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** `files` maps stable names (`sky`, `portrait`, `p1`/`p2`, `intro`/`phase`/`taunt0`…) to absolute URLs. */
export interface AssetBundle { kind: AssetKind; files: Record<string, string> }

const ASSET_TIMEOUT_MS = 90_000;

/** The voice request carries the exact lines this client shows as subtitles, so the audio is never an older self's script. */
export async function requestAsset(spec: Pick<NemesisSpec, "code" | "voice">, kind: AssetKind): Promise<AssetBundle> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_TIMEOUT_MS);
  try {
    const voice = kind === "voice" ? { designPrompt: spec.voice.designPrompt, lines: spec.voice.lines } : undefined;
    const response = await fetch(`${FORGE_URL}/forge/asset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: spec.code, kind, voice }),
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
export function requestAllAssets(spec: Pick<NemesisSpec, "code" | "voice">, listener: AssetListener, kinds: readonly AssetKind[] = ASSET_KINDS): Promise<void> {
  return Promise.all(kinds.map((kind) =>
    requestAsset(spec, kind).then(listener.onReady, (error: unknown) => listener.onFail(kind, error)),
  )).then(() => undefined);
}
