import type { Env } from "./env";
import type { MediaBlob } from "./gemini";

/** Bump when tuning or staging changes so cached clips re-render. */
export const VOICE_RENDER_VERSION = 2;
/** Gradium json_config: livelier prosody, closer to the designed voice, a beat slower for menace. */
const TTS_TUNING = { temp: 0.85, cfg_coef: 2.5, padding_bonus: 0.6 };
/** Turn written pauses into Gradium break tags so lines breathe instead of being read flat. */
export const stageText = (text: string): string =>
  text
    .replace(/(\.\.\.|…)/g, ' <break time="0.6s" /> ')
    .replace(/\s+—\s+/g, ' <break time="0.4s" /> ')
    .replace(/\s+/g, " ")
    .trim();

// https://docs.gradium.ai — REST base; browsers only ever receive short-lived tokens, never GRADIUM_API_KEY.
const BASE = "https://api.gradium.ai/api";
const VOICE_READY_TIMEOUT_MS = 25_000;
const VOICE_POLL_MS = 1200;

export interface GradiumToken { token: string; expires_at: string }

const headers = (env: Env): HeadersInit => ({ "x-api-key": env.GRADIUM_API_KEY, "content-type": "application/json" });

async function expectOk(response: Response, label: string): Promise<Response> {
  if (!response.ok) throw new Error(`gradium ${label} ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response;
}

/** Single-use token for a browser WebSocket (STT); one per connection. */
export async function mintGradiumToken(env: Env): Promise<GradiumToken> {
  const response = await expectOk(await fetch(`${BASE}/api-keys/token`, { headers: { "x-api-key": env.GRADIUM_API_KEY } }), "token");
  return (await response.json()) as GradiumToken;
}

interface EmbeddingList { embeddings: Array<{ embedding_id: string; ready: boolean }> }

/**
 * Voice Design: sample one candidate from the spec's designPrompt and wait until it is ready.
 * Candidates are usable as `voice_id` directly, so we never promote them to permanent voices
 * (which would eat custom-voice slots); callers discard the candidate once every line is synthesized.
 */
export async function designVoice(env: Env, prompt: string): Promise<string> {
  const created = await expectOk(await fetch(`${BASE}/voice-generator/generate`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ prompt: prompt.slice(0, 500), language: "en", n_samples: 1 }),
  }), "voice design");
  const id = ((await created.json()) as EmbeddingList).embeddings[0]?.embedding_id;
  if (!id) throw new Error("gradium voice design returned no candidate");

  const deadline = Date.now() + VOICE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await expectOk(await fetch(`${BASE}/voice-generator/embeddings?embedding_id=${id}`, { headers: headers(env) }), "voice status");
    if (((await status.json()) as EmbeddingList).embeddings[0]?.ready) return id;
    await new Promise((resolve) => setTimeout(resolve, VOICE_POLL_MS));
  }
  throw new Error("gradium voice design timed out");
}

export async function synthesize(env: Env, voiceId: string, text: string): Promise<MediaBlob> {
  const response = await expectOk(await fetch(`${BASE}/post/speech/tts`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ text: stageText(text), voice_id: voiceId, output_format: "opus", only_audio: true, json_config: JSON.stringify(TTS_TUNING) }),
  }), "tts");
  return { mimeType: response.headers.get("content-type") ?? "audio/ogg", bytes: new Uint8Array(await response.arrayBuffer()) };
}

export async function discardVoice(env: Env, embeddingId: string): Promise<void> {
  await fetch(`${BASE}/voice-generator/embeddings/${embeddingId}`, { method: "DELETE", headers: headers(env) }).catch(() => undefined);
}
