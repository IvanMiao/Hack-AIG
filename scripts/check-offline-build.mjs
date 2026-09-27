import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
if (existsSync(join(dist, "dev.html"))) throw new Error("debug lab must not ship to itch.io");
const files = [join(dist, "index.html"), ...readdirSync(join(dist, "assets"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => join(dist, "assets", name))];
const forbidden = [
  /nemesis-forge\.[a-z0-9.-]*workers\.dev/i,
  /\/(?:forge|learn|voice-token|lineage|nemesis)(?:\/|["'`])/i,
  /id=["'](?:incantation-input|hunt-form|share-btn)["']/i,
];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  if (forbidden.some((pattern) => pattern.test(content))) {
    throw new Error(`paid AI or sharing route found in public build: ${file}`);
  }
}
console.log("Offline release check passed");
