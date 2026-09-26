# Nemesis

> One sentence. One boss. It remembers.

Speak a nightmare into existence, fight it, and it learns how you die. Built for the Open Innovation Track with Gemini 3.8 Flash (boss spec), Nano Banana (sky + portrait), Lyria (two-phase score) and Gradium (voice design + TTS), behind a Cloudflare Worker.

Play: https://ivanmiao.itch.io/nemesis · Roadmap and architecture: [`docs/ROADMAP.md`](docs/ROADMAP.md)

## Develop

```bash
npm ci
npm run worker:dev   # Worker on :8787 (needs .dev.vars with GEMINI_API_KEY, GRADIUM_API_KEY)
npm run dev          # Vite on :5173, proxies /api → Worker
npm run verify       # typecheck + tests + build
```

Bound (offline) nightmares ship with baked sky/portrait/music/voice under `public/fallback/<code>/`, indexed by `src/fallbackAssets.json`. After editing `src/spec/fallback.ts`, re-bake so the build needs no network for them:

```bash
GEMINI_API_KEY=… GRADIUM_API_KEY=… npm run bake:fallback              # every bound spec, skips kinds already baked
GEMINI_API_KEY=… GRADIUM_API_KEY=… npm run bake:fallback -- VESSEL-01 voice --force   # one code / kinds, overwrite
```

Sharing: every summon has a code (`spec.code`). The outcome screen offers `SEND IT HUNTING` (Web Share or clipboard), links carry `?n=CODE`, and the incantation screen has a `HUNT IT` field. Kills and victories per code are counted in Worker KV (`/lineage/:code`); the shared spec is whatever generation it has learned up to (`GET /nemesis/:code`).

## Publish

Every push to `main` runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

1. `npm run verify` → `npm run build:itch` (relative-path static build, itch.io HTML rules checked).
2. `butler push dist ivanmiao/nemesis:html` — itch.io's CLI uploads a delta and the page serves the new build immediately (`--userversion` = commit SHA).
3. `wrangler deploy` for the Worker (skipped if `CLOUDFLARE_API_TOKEN` is absent).

Repository secrets required: `BUTLER_API_KEY` (itch.io → Settings → API keys), `CLOUDFLARE_API_TOKEN` (Workers + KV edit). Worker secrets (`GEMINI_API_KEY`, `GRADIUM_API_KEY`, optional `ELEVENLABS_API_KEY`) live in Cloudflare via `wrangler secret put`.

Manual first-time itch.io setup: create an **HTML** project, upload `nemesis-itch.zip` (from `npm run build:itch`) with "This file will be played in the browser", viewport 1280×720, fullscreen button on, SharedArrayBuffer support **off**. After that, the workflow keeps the page in sync with `main`.
