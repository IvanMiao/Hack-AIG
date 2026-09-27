import type { Env } from "./env";
import { buildAsset, buildVoiceAsset, isAssetKind, loadSpecByCode, parseVoiceScript, readBlob } from "./assets";
import { forgeNemesis } from "./forge";
import { mintForgeToken, verifyForgeToken } from "./forgeToken";
import { mintGradiumToken } from "./gradium";
import { corsHeaders, error, json, readJson } from "./http";
import { learnNemesis } from "./learn";
import { getLineage, recordOutcome } from "./lineage";
import { rateLimit, type RateLimitBucket } from "./rateLimit";
import { parseDeathLog } from "../../src/spec";

const MAX_INCANTATION_CHARS = 280;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    const throttled = async (bucket: RateLimitBucket, subject?: string): Promise<Response | null> => {
      const verdict = await rateLimit(env, request, bucket, subject);
      if (verdict.allowed) return null;
      return error(429, "too many requests", { ...cors, "retry-after": String(verdict.retryAfterSeconds) });
    };

    try {
      if (path === "/" || path === "/health") return json({ ok: true, service: "nemesis-forge" }, {}, cors);

      if (path === "/forge" && request.method === "POST") {
        const body = await readJson<{ incantation?: string }>(request);
        const incantation = body?.incantation?.trim() ?? "";
        if (incantation.length < 4) return error(400, "incantation too short", cors);
        if (incantation.length > MAX_INCANTATION_CHARS) return error(400, "incantation too long", cors);
        const limited = await throttled("forge");
        if (limited) return limited;
        const forged = await forgeNemesis(env, incantation);
        const [lineage, token] = await Promise.all([getLineage(env, forged.spec.code), mintForgeToken(env, forged.spec.code)]);
        return json({ ...forged, lineage, token }, {}, cors);
      }

      const nemesisMatch = /^\/nemesis\/([A-Za-z0-9-]{4,16})$/.exec(path);
      if (nemesisMatch && request.method === "GET") {
        const code = nemesisMatch[1] ?? "";
        const spec = await loadSpecByCode(env, code);
        if (!spec) return error(404, "unknown nemesis", cors);
        const [lineage, token] = await Promise.all([getLineage(env, spec.code), mintForgeToken(env, spec.code)]);
        return json({ spec, lineage, token }, {}, cors);
      }

      if (path === "/forge/asset" && request.method === "POST") {
        const body = await readJson<{ code?: string; kind?: string; voice?: unknown; token?: unknown }>(request);
        const code = body?.code ?? "";
        if (!/^[A-Za-z0-9-]{4,16}$/.test(code)) return error(400, "bad code", cors);
        if (!isAssetKind(body?.kind)) return error(400, "kind must be sky|portrait|music|voice", cors);
        if (!(await verifyForgeToken(env, code, body.token))) return error(401, "forge token required", cors);
        const limited = await throttled("asset");
        if (limited) return limited;
        // Uncached voice renders are the one generation whose input the caller controls, so they are also capped per code.
        let voiceRenderRefused: Response | null = null;
        const allowVoiceRender = async () => (voiceRenderRefused = await throttled("voiceBuild", code.toUpperCase())) === null;
        // The client sends the lines it will subtitle; the voice is synthesized from those exact words, even for a
        // bound nightmare this Worker build has never heard of.
        if (body.kind === "voice" && body.voice !== undefined) {
          const script = parseVoiceScript(body.voice);
          if (!script) return error(400, "bad voice script", cors);
          const manifest = await buildVoiceAsset(env, code, script, allowVoiceRender);
          return manifest ? json(manifest, {}, cors) : voiceRenderRefused ?? error(429, "too many requests", cors);
        }
        const spec = await loadSpecByCode(env, code);
        if (!spec) return error(404, "unknown nemesis", cors);
        const manifest = await buildAsset(env, spec, body.kind, allowVoiceRender);
        return manifest ? json(manifest, {}, cors) : voiceRenderRefused ?? error(429, "too many requests", cors);
      }

      const assetMatch = /^\/asset\/([A-Za-z0-9-]{4,16})\/([A-Za-z0-9-]{1,48})$/.exec(path);
      if (assetMatch && request.method === "GET") {
        const blob = await readBlob(env, assetMatch[1] ?? "", assetMatch[2] ?? "");
        if (!blob) return error(404, "no such asset", cors);
        return new Response(blob.bytes, { headers: { ...cors, "content-type": blob.contentType, "cache-control": "public, max-age=604800, immutable" } });
      }

      if (path === "/learn" && request.method === "POST") {
        // The stored spec is the only one that evolves: the client names the code and describes the death, nothing more.
        const body = await readJson<{ code?: unknown; deathLog?: unknown }>(request);
        const code = typeof body?.code === "string" ? body.code : "";
        if (!/^[A-Za-z0-9-]{4,16}$/.test(code)) return error(400, "bad code", cors);
        const log = parseDeathLog(body?.deathLog);
        if (!log.ok) return error(400, `bad deathLog: ${log.errors.join("; ")}`, cors);
        const spec = await loadSpecByCode(env, code);
        if (!spec) return error(404, "unknown nemesis", cors);
        const limited = await throttled("learn");
        if (limited) return limited;
        return json(await learnNemesis(env, spec, log.log), {}, cors);
      }

      if (path === "/voice-token" && request.method === "POST") {
        const limited = await throttled("voiceToken");
        if (limited) return limited;
        return json(await mintGradiumToken(env), {}, cors);
      }

      const lineageMatch = /^\/lineage\/([A-Za-z0-9-]{4,16})$/.exec(path);
      if (lineageMatch) {
        const code = lineageMatch[1] ?? "";
        if (request.method === "GET") return json(await getLineage(env, code), {}, cors);
        if (request.method === "POST") {
          const body = await readJson<{ outcome?: "kill" | "victory" }>(request);
          if (body?.outcome !== "kill" && body?.outcome !== "victory") return error(400, "outcome must be kill|victory", cors);
          const limited = (await throttled("lineage")) ?? (await throttled("lineageCode", code.toUpperCase()));
          if (limited) return limited;
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
