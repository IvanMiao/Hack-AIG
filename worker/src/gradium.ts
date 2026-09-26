import type { Env } from "./env";

// TODO(H0): confirm exact token endpoint path/shape against https://gradium.ai/docs before first deploy.
const GRADIUM_TOKEN_URL = "https://api.gradium.ai/api/auth/token";

/** Browsers never see GRADIUM_API_KEY; they get a short-lived single-use token per WebSocket connection. */
export async function mintGradiumToken(env: Env): Promise<unknown> {
  const response = await fetch(GRADIUM_TOKEN_URL, {
    method: "POST",
    headers: { "x-api-key": env.GRADIUM_API_KEY, "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`gradium token ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}
