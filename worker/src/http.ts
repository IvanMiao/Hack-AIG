import type { Env } from "./env";

export function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  // itch.io serves games from per-project subdomains of itch.zone, so allow that whole zone.
  const ok = allowed.includes(origin) || /^https:\/\/[a-z0-9-]+\.itch\.zone$/.test(origin) || origin.endsWith(".pages.dev");
  return {
    "access-control-allow-origin": ok ? origin : allowed[0] ?? "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

export const json = (body: unknown, init: ResponseInit = {}, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...extra, ...(init.headers ?? {}) } });

export const error = (status: number, message: string, extra: HeadersInit = {}) => json({ error: message }, { status }, extra);

export async function readJson<T>(request: Request): Promise<T | null> {
  try { return (await request.json()) as T; } catch { return null; }
}
