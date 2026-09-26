// H0 smoke test: prove each partner API answers with the real keys before wiring the game to them.
// Usage: GEMINI_API_KEY=... GRADIUM_API_KEY=... [ELEVENLABS_API_KEY=...] node scripts/smoke.mjs [gemini|image|lyria|gradium|elevenlabs|all]
import { mkdirSync, writeFileSync } from "node:fs";

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const OUT = "smoke-out";
mkdirSync(OUT, { recursive: true });
const which = process.argv[2] ?? "all";
const run = (name) => which === "all" || which === name;
const timed = async (label, fn) => {
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`OK   ${label} (${((Date.now() - start) / 1000).toFixed(1)}s)${result ? ` → ${result}` : ""}`);
  } catch (error) {
    process.exitCode = 1;
    console.log(`FAIL ${label} (${((Date.now() - start) / 1000).toFixed(1)}s): ${error.message}`);
  }
};
const gemini = async (model, body) => {
  const response = await fetch(`${GEMINI}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 400)}`);
  return response.json();
};
const parts = (data) => data.candidates?.[0]?.content?.parts ?? [];
const saveInline = (data, file) => {
  const inline = parts(data).find((p) => p.inlineData)?.inlineData;
  if (!inline) throw new Error(`no inlineData; parts=${JSON.stringify(parts(data)).slice(0, 300)}`);
  const path = `${OUT}/${file}`;
  writeFileSync(path, Buffer.from(inline.data, "base64"));
  return `${path} (${inline.mimeType})`;
};

if (run("gemini")) await timed("gemini structured output", async () => {
  const data = await gemini(process.env.GEMINI_TEXT_MODEL ?? "gemini-3.8-flash", {
    contents: [{ parts: [{ text: "Name a boss for: an iron knight who drowned his daughter. JSON." }] }],
    generationConfig: {
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: {
        type: "object", properties: { name: { type: "string" }, element: { type: "string", enum: ["fire", "ice", "void"] } }, required: ["name", "element"],
      } } },
    },
  });
  return parts(data).map((p) => p.text).join("");
});

if (run("image")) await timed("nano banana image", async () => {
  const data = await gemini("gemini-3.1-flash-image", {
    contents: [{ parts: [{ text: "Equirectangular 360 panorama of a drowned cathedral under black water, shafts of cyan light, ink wash illustration with neon rim light, pure black void, no text." }] }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
  });
  return saveInline(data, "sky.png");
});

const MUSIC_PROMPTS = {
    grief: "Instrumental boss battle loop, slow minor-key pipe organ and submerged choir, 70 bpm, mournful, dark fantasy, seamless loop, no vocals",
    rage: "Instrumental boss battle loop, aggressive taiko drums and distorted low brass, 150 bpm, relentless, dark fantasy, seamless loop, no vocals",
};

if (run("lyria")) {
  for (const [temper, text] of Object.entries(MUSIC_PROMPTS)) {
    await timed(`lyria clip ${temper}`, async () => {
      const data = await gemini("lyria-3-clip-preview", { contents: [{ parts: [{ text }] }] });
      return saveInline(data, `lyria-${temper}.mp3`);
    });
  }
}

if (run("gradium")) await timed("gradium token", async () => {
  const response = await fetch("https://api.gradium.ai/api/api-keys/token", { headers: { "x-api-key": process.env.GRADIUM_API_KEY } });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`);
  const { expires_at } = await response.json();
  return `expires_at=${expires_at}`;
});

if (which === "elevenlabs" && !process.env.ELEVENLABS_API_KEY) {
  console.log("FAIL elevenlabs music: ELEVENLABS_API_KEY not set");
  process.exitCode = 1;
}
if (run("elevenlabs") && process.env.ELEVENLABS_API_KEY) {
  for (const [temper, prompt] of Object.entries(MUSIC_PROMPTS)) {
    await timed(`elevenlabs music ${temper}`, async () => {
      const response = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": process.env.ELEVENLABS_API_KEY },
        body: JSON.stringify({ model_id: "music_v2", prompt, music_length_ms: 30000 }),
      });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 300)}`);
      const path = `${OUT}/elevenlabs-${temper}.mp3`;
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
      return path;
    });
  }
}
