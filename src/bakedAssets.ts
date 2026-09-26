import manifest from "./fallbackAssets.json";
import { ASSET_KINDS, type AssetBundle, type AssetKind } from "./assetsClient";

/** Written by `scripts/bake-fallback.ts`: per bound-nightmare code, the files under public/fallback/<code>/ keyed like a Worker manifest. */
export type BakedManifest = Record<string, Partial<Record<AssetKind, Record<string, string>>>>;

const BAKED: BakedManifest = manifest;

const resolve = (path: string) => `${import.meta.env.BASE_URL}${path}`;

/** Asset bundles that ship inside the build for this code, so bound nightmares need no network. */
export function bakedBundles(code: string): AssetBundle[] {
  const entry = BAKED[code];
  if (!entry) return [];
  const bundles: AssetBundle[] = [];
  for (const kind of ASSET_KINDS) {
    const files = entry[kind];
    if (!files || Object.keys(files).length === 0) continue;
    bundles.push({ kind, files: Object.fromEntries(Object.entries(files).map(([name, path]) => [name, resolve(path)])) });
  }
  return bundles;
}
