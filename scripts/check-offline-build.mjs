import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
if (existsSync(join(dist, "dev.html"))) throw new Error("debug lab must not ship to itch.io");
const files = [join(dist, "index.html"), ...readdirSync(join(dist, "assets"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => join(dist, "assets", name))];
const forbidden = [
  /nemesis-forge\.[a-z0-9.-]*workers\.dev/i,
  /lil-gui|dev\.html/i,
  /\/(?:forge|learn|voice-token|lineage|nemesis)(?:\/|["'`])/i,
  /id=["'](?:incantation-input|hunt-form|share-btn)["']/i,
];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  if (forbidden.some((pattern) => pattern.test(content))) {
    throw new Error(`paid AI or sharing route found in public build: ${file}`);
  }
}
const manifest = JSON.parse(readFileSync("src/fallbackAssets.json", "utf8"));
let assetCount = 0;
for (const [code, bundles] of Object.entries(manifest)) {
  for (const files of Object.values(bundles)) {
    for (const path of Object.values(files)) {
      if (typeof path !== "string" || !new RegExp(`^fallback/${code}/[A-Za-z0-9._-]+$`).test(path)) {
        throw new Error(`invalid static asset path: ${path}`);
      }
      const builtFile = join(dist, path);
      if (!existsSync(builtFile) || !statSync(builtFile).isFile()) {
        throw new Error(`static asset missing from production build: ${builtFile}`);
      }
      assetCount += 1;
    }
  }
}
if (assetCount === 0) throw new Error("static asset manifest is empty");
console.log(`Offline release check passed (${assetCount} static assets)`);
