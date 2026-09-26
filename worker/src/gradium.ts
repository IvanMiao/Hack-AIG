import type { Env } from "./env";

// https://docs.gradium.ai/guides/browser-websockets — GET with x-api-key returns { token, expires_at }.
const GRADIUM_TOKEN_URL = "https://api.gradium.ai/api/api-keys/token";

export interface GradiumToken { token: string; expires_at: string }

/** Browsers never see GRADIUM_API_KEY; they get a short-lived single-use token per WebSocket connection. */
export async function mintGradiumToken(env: Env): Promise<GradiumToken> {
  const response = await fetch(GRADIUM_TOKEN_URL, { headers: { "x-api-key": env.GRADIUM_API_KEY } });
  if (!response.ok) throw new Error(`gradium token ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as GradiumToken;
}
