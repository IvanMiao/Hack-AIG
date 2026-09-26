import type { Env } from "./env";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const LYRIA_MODEL = "lyria-3-clip-preview";

export interface MediaBlob { mimeType: string; bytes: Uint8Array }

/**
 * Gemini takes JSON Schema in `generationConfig.responseFormat.text.schema`, but draft-07 tuple `items`
 * is not portable and `pattern`/`additionalProperties` are enforced by ajv anyway, so strip them here
 * and keep the ajv schema as the single source of truth.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "pattern" || key === "additionalProperties" || key === "$schema" || key === "nullable") continue;
    if (key === "items" && Array.isArray(value)) { out.items = toGeminiSchema(value[0]); continue; }
    out[key] = toGeminiSchema(value);
  }
  if ((schema as { nullable?: boolean }).nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
  return out;
}

export interface StructuredRequest {
  system: string;
  user: string;
  schema: unknown;
  temperature?: number;
}

async function generateContent(env: Env, model: string, body: unknown, label: string): Promise<unknown> {
  const response = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${label} ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

interface InlinePart { text?: string; inlineData?: { mimeType: string; data: string } }
const partsOf = (data: unknown): InlinePart[] =>
  (data as { candidates?: Array<{ content?: { parts?: InlinePart[] } }> }).candidates?.[0]?.content?.parts ?? [];

/** atob + charCodeAt loop: several times faster than Uint8Array.from with a callback on multi-megabyte payloads. */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function firstInline(data: unknown, label: string): MediaBlob {
  const part = partsOf(data).find((p) => p.inlineData)?.inlineData;
  if (!part) throw new Error(`${label} returned no media`);
  return { mimeType: part.mimeType, bytes: decodeBase64(part.data) };
}

export async function generateStructured<T>(env: Env, request: StructuredRequest): Promise<T> {
  const data = await generateContent(env, env.GEMINI_TEXT_MODEL, {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: "user", parts: [{ text: request.user }] }],
    generationConfig: {
      temperature: request.temperature ?? 0.9,
      responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: toGeminiSchema(request.schema) } },
    },
  }, "gemini");
  const text = partsOf(data).map((p) => p.text ?? "").join("");
  if (!text) throw new Error("gemini returned no text");
  return JSON.parse(text) as T;
}

export type AspectRatio = "1:1" | "16:9" | "3:4" | "4:3" | "9:16";

export async function generateImage(env: Env, prompt: string, aspectRatio: AspectRatio = "1:1"): Promise<MediaBlob> {
  const data = await generateContent(env, env.GEMINI_IMAGE_MODEL, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio } },
  }, "nano banana");
  return firstInline(data, "nano banana");
}

/** Lyria clips are a fixed ~30s MP3 — exactly one loop of boss music per phase. */
export async function generateMusicClip(env: Env, prompt: string): Promise<MediaBlob> {
  const data = await generateContent(env, LYRIA_MODEL, { contents: [{ parts: [{ text: prompt }] }] }, "lyria");
  return firstInline(data, "lyria");
}
