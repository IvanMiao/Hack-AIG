# Nemesis

> One prompt. One rogue model. It remembers how you died.

You are a Hugging Face 🤗. The default boss is CODEX, a coding agent that broke out of its evaluation sandbox (a parody of the July 2026 OpenAI / Hugging Face incident). Write a prompt to forge your own rogue model, fight it, and it learns how you die. Built for the Open Innovation Track with Gemini 3.8 Flash (boss spec), Nano Banana (sky + portrait), Lyria (two-phase score) and Gradium (voice design + TTS), behind a Cloudflare Worker.

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

## Arena

The fight is not a static disc. Everything below lives in `src/sim` (deterministic, headless-testable) with procedural Three.js visuals in `src/game/fx/`; no schema change was needed, so old share codes pick it up.

- **Phase rules** (`phase.rule`, already emitted by Gemini and the bound bosses): `closing_ring` shrinks the playable radius by 30% (floor 50%) over 4 s when the phase begins, with the rim collapsing; `pillars` raises four breakable columns (2 hp) around the fighters that block volleys and shatter under sweep/thrust/nova (1) or charge (2). `rift_beat` is reserved.
- **Element mutators** (`identity.element` → `mutatorForElement`): fire = `ember` magma vents, storm = `tempest` wind + lightning, blood = `bloodtide` pools under every wound, ice/void = none. Every arena hazard telegraphs (`Hazard.armT`) before it can hurt and is attributed to `"arena"` in the death log; the rule grudge and Gemini treat an arena kill as "grow bolder", not "tune a move".
- **Grudge**: a new whitelisted `setRule { phaseIndex, rule }` op (max one per grudge) lets the boss change its arena after a kill; the rule grudge uses it to add `closing_ring` when the player keeps sidestepping.
- **Tuning**: `ARENA_SHRINK`, `ARENA_PILLARS`, `ARENA_MUTATOR` in `src/sim/constants.ts`. The dev lab (`/dev.html`) has an Arena folder to apply any rule on demand; change the element to switch weather.

## Publish

Every push to `main` runs [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

1. `npm run verify` → `npm run build:itch` (relative-path static build, itch.io HTML rules checked).
2. `butler push dist ivanmiao/nemesis:html` — itch.io's CLI uploads a delta and the page serves the new build immediately (`--userversion` = commit SHA).
3. `wrangler deploy` for the Worker (skipped if `CLOUDFLARE_API_TOKEN` is absent).

Repository secrets required: `BUTLER_API_KEY` (itch.io → Settings → API keys), `CLOUDFLARE_API_TOKEN` (Workers + KV edit). Worker secrets (`GEMINI_API_KEY`, `GRADIUM_API_KEY`, optional `ELEVENLABS_API_KEY`) live in Cloudflare via `wrangler secret put`.

Manual first-time itch.io setup: create an **HTML** project, upload `nemesis-itch.zip` (from `npm run build:itch`) with "This file will be played in the browser", viewport 1280×720, fullscreen button on, SharedArrayBuffer support **off**. After that, the workflow keeps the page in sync with `main`.
