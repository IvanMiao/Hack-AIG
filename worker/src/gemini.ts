import type { Env } from "./env";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

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
    if (key === "pattern" || key === "additionalProperties" || key === "$schema") continue;
    if (key === "items" && Array.isArray(value)) { out.items = toGeminiSchema(value[0]); continue; }
    if (key === "nullable") { if (value === true) out.type = [out.type ?? (schema as { type?: string }).type, "null"]; continue; }
    out[key] = toGeminiSchema(value);
  }
  return out;
}

export interface StructuredRequest {
  system: string;
  user: string;
  schema: unknown;
  temperature?: number;
}

export async function generateStructured<T>(env: Env, request: StructuredRequest): Promise<T> {
  const response = await fetch(`${BASE}/models/${env.GEMINI_TEXT_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.user }] }],
      generationConfig: {
        temperature: request.temperature ?? 0.9,
        responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: toGeminiSchema(request.schema) } },
      },
    }),
  });
  if (!response.ok) throw new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!text) throw new Error("gemini returned no text");
  return JSON.parse(text) as T;
}

export async function generateImage(env: Env, prompt: string): Promise<{ mimeType: string; bytes: Uint8Array }> {
  const response = await fetch(`${BASE}/models/${env.GEMINI_IMAGE_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"] } }),
  });
  if (!response.ok) throw new Error(`nano banana ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType: string; data: string } }> } }> };
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!part) throw new Error("nano banana returned no image");
  return { mimeType: part.mimeType, bytes: Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0)) };
}
