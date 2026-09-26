import type { Env } from "./env";
import { buildAsset, isAssetKind, loadSpecByCode, readBlob } from "./assets";
import { forgeNemesis } from "./forge";
import { mintGradiumToken } from "./gradium";
import { corsHeaders, error, json, readJson } from "./http";
import { learnNemesis } from "./learn";
import { getLineage, recordOutcome } from "./lineage";
import { checkInvariants, type NemesisSpec } from "../../src/spec";
import type { DeathLog } from "../../src/sim/types";

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
        const forged = await forgeNemesis(env, incantation);
        return json({ ...forged, lineage: await getLineage(env, forged.spec.code) }, {}, cors);
      }

      const nemesisMatch = /^\/nemesis\/([A-Za-z0-9-]{4,16})$/.exec(path);
      if (nemesisMatch && request.method === "GET") {
        const code = nemesisMatch[1] ?? "";
        const spec = await loadSpecByCode(env, code);
        if (!spec) return error(404, "unknown nemesis", cors);
        return json({ spec, lineage: await getLineage(env, spec.code) }, {}, cors);
      }

      if (path === "/forge/asset" && request.method === "POST") {
        const body = await readJson<{ code?: string; kind?: string }>(request);
        const code = body?.code ?? "";
        if (!/^[A-Za-z0-9-]{4,16}$/.test(code)) return error(400, "bad code", cors);
        if (!isAssetKind(body?.kind)) return error(400, "kind must be sky|portrait|music|voice", cors);
        const spec = await loadSpecByCode(env, code);
        if (!spec) return error(404, "unknown nemesis", cors);
        return json(await buildAsset(env, spec, body.kind), {}, cors);
      }

      const assetMatch = /^\/asset\/([A-Za-z0-9-]{4,16})\/([a-z0-9-]{1,32})$/.exec(path);
      if (assetMatch && request.method === "GET") {
        const blob = await readBlob(env, assetMatch[1] ?? "", assetMatch[2] ?? "");
        if (!blob) return error(404, "no such asset", cors);
        return new Response(blob.bytes, { headers: { ...cors, "content-type": blob.contentType, "cache-control": "public, max-age=604800, immutable" } });
      }

      if (path === "/learn" && request.method === "POST") {
        const body = await readJson<{ spec?: NemesisSpec; deathLog?: DeathLog }>(request);
        if (!body?.spec || !body?.deathLog) return error(400, "need spec and deathLog", cors);
        const problems = checkInvariants(body.spec);
        if (problems.length > 0) return error(400, `unfair spec: ${problems.join("; ")}`, cors);
        return json(await learnNemesis(env, body.spec, body.deathLog), {}, cors);
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
