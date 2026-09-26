import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROMPTS = join(ROOT, "blender/art/prompts.json");
const RAW = join(ROOT, "blender/art/raw");
const API = "https://generativelanguage.googleapis.com/v1beta";

class GeminiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const mimeExtensions = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

const readInlineImage = (response) => {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const image = parts.find((part) => part.inlineData)?.inlineData;
  if (!image?.data || !mimeExtensions.has(image.mimeType)) {
    throw new Error("Gemini response did not contain a supported inline image.");
  }
  return { bytes: Buffer.from(image.data, "base64"), extension: mimeExtensions.get(image.mimeType) };
};

const generate = async (model, prompt, aspectRatio) => {
  const response = await fetch(`${API}/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio },
      },
    }),
  });
  if (!response.ok) {
    throw new GeminiError(response.status, (await response.text()).slice(0, 500));
  }
  return readInlineImage(await response.json());
};

const existingRaw = (id) => readdirSync(RAW).find((name) => name.startsWith(`${id}.`));

const main = async () => {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required.");
  const config = JSON.parse(readFileSync(PROMPTS, "utf8"));
  const items = [...config.textures, ...config.references];
  const selectedIds = process.argv.slice(2).filter((argument) => argument !== "--force");
  const force = process.argv.includes("--force");
  const selected = selectedIds.length ? items.filter(({ id }) => selectedIds.includes(id)) : items;
  const unknown = selectedIds.filter((id) => !items.some((item) => item.id === id));
  if (unknown.length) throw new Error(`Unknown art item ID(s): ${unknown.join(", ")}`);
  mkdirSync(RAW, { recursive: true });

  for (const item of selected) {
    const existing = existingRaw(item.id);
    if (existing && !force) {
      console.info(`SKIP ${item.id}: ${existing} already exists`);
      continue;
    }

    let image;
    let aspectRatio = item.aspectRatio;
    try {
      image = await generate(config.model, item.prompt, aspectRatio);
    } catch (error) {
      const isRatioRejection = error instanceof GeminiError
        && error.status === 400
        && /aspect.?ratio|ratio.*(?:valid|support|allow)|21:9/i.test(error.message);
      if (aspectRatio !== "21:9" || !isRatioRejection) throw error;
      aspectRatio = "16:9";
      console.warn(`RETRY ${item.id}: 21:9 was rejected; using 16:9`);
      image = await generate(config.model, item.prompt, aspectRatio);
    }

    for (const name of readdirSync(RAW)) {
      if (name.startsWith(`${item.id}.`)) unlinkSync(join(RAW, name));
    }
    const destination = join(RAW, `${item.id}.${image.extension}`);
    writeFileSync(destination, image.bytes);
    console.info(`SAVED ${item.id}: ${destination} (${aspectRatio})`);
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
