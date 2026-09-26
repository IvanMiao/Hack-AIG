import AdmZip from "adm-zip";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// itch.io HTML rules: index.html at zip root, relative asset paths, <=1000 files, <=500MB unzipped.
const dist = "dist";
if (!existsSync(join(dist, "index.html"))) throw new Error("dist/index.html missing — run vite build first");

let fileCount = 0;
let byteCount = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full);
    else { fileCount += 1; byteCount += stat.size; }
  }
};
walk(dist);
if (fileCount > 1000) throw new Error(`itch.io limit: ${fileCount} files > 1000`);
if (byteCount > 500 * 1024 * 1024) throw new Error(`itch.io limit: ${(byteCount / 1e6).toFixed(1)}MB > 500MB`);

const zip = new AdmZip();
zip.addLocalFolder(dist);
const out = "nemesis-itch.zip";
zip.writeZip(out);
console.log(`${out}: ${fileCount} files, ${(byteCount / 1024).toFixed(0)} KB unzipped`);
