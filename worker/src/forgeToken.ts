import type { Env } from "./env";

/**
 * Proof that a code was handed out by this Worker (/forge or /nemesis/:code). Asset generation requires it so a caller
 * cannot bill TTS/image/music work for arbitrary codes. HMAC-SHA256 over the code; the secret never leaves the Worker.
 */
const TOKEN_BYTES = 16;

async function hmacKey(env: Env): Promise<CryptoKey> {
  const secret = env.FORGE_TOKEN_SECRET ?? env.GEMINI_API_KEY;
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function mintForgeToken(env: Env, code: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(`forge:${code.toUpperCase()}`));
  return [...new Uint8Array(mac)].slice(0, TOKEN_BYTES).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyForgeToken(env: Env, code: string, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length !== TOKEN_BYTES * 2) return false;
  const expected = await mintForgeToken(env, code);
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
