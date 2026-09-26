import type { Env } from "./env";
import { forgeNemesis } from "./forge";
import { mintGradiumToken } from "./gradium";
import { corsHeaders, error, json, readJson } from "./http";
import { getLineage, recordOutcome } from "./lineage";

const MAX_INCANTATION_CHARS = 280;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/" || path === "/health") return json({ ok: true, service: "nemesis-forge" }, {}, cors);

      if (path === "/forge" && request.method === "POST") {
        const body = await readJson<{ incantation?: string }>(request);
        const incantation = body?.incantation?.trim() ?? "";
        if (incantation.length < 4) return error(400, "incantation too short", cors);
        if (incantation.length > MAX_INCANTATION_CHARS) return error(400, "incantation too long", cors);
        return json(await forgeNemesis(env, incantation), {}, cors);
      }

      if (path === "/learn" && request.method === "POST") {
        // H3: Gemini turns a death log into a whitelisted spec patch. Until then the client applies local rule patches.
        return error(501, "learn not implemented yet", cors);
      }

      if (path === "/voice-token" && request.method === "POST") {
        return json(await mintGradiumToken(env), {}, cors);
      }

      const lineageMatch = /^\/lineage\/([A-Za-z0-9-]{4,16})$/.exec(path);
      if (lineageMatch) {
        const code = lineageMatch[1] ?? "";
        if (request.method === "GET") return json(await getLineage(env, code), {}, cors);
        if (request.method === "POST") {
          const body = await readJson<{ outcome?: "kill" | "victory" }>(request);
          if (body?.outcome !== "kill" && body?.outcome !== "victory") return error(400, "outcome must be kill|victory", cors);
          return json(await recordOutcome(env, code, body.outcome), {}, cors);
        }
      }

      return error(404, "not found", cors);
    } catch (cause) {
      console.error(cause);
      return error(502, cause instanceof Error ? cause.message : "upstream failure", cors);
    }
  },
} satisfies ExportedHandler<Env>;
