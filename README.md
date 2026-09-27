# Nemesis

Choose one of six bundled bosses, learn its moves, and fight again. The public game runs without AI services or a game backend. Boss specs and available music, portraits, skies, and voices ship as static assets. The post-mortem grudge uses deterministic local rules.

Play: https://ivanmiao.itch.io/nemesis

## Develop

```bash
npm ci
npm run dev       # playable game on :5173; /dev.html is the local tuning lab
npm run verify    # typecheck, tests, production build
npm run build:itch
```

The boss specs live in `src/spec/fallback.ts`. Compressed release media lives under `public/fallback` and is indexed by `src/fallbackAssets.json`; the production build checks that every indexed file is present. Keep editable audio and art masters in a separate backup. Missing optional media stays unavailable in the offline game. The media-generation scripts remain in the repository for private asset production and require the developer's own API keys. They are not part of the public game or deployed Worker.

`/dev.html` uses `lil-gui` for local fight and visual tuning. It is a development dependency and is excluded from the itch.io build.

## Public release

Every push to `main` runs [the static publish workflow](.github/workflows/publish.yml), which verifies the game and uploads only the static build to itch.io. It does not deploy the Cloudflare Worker.

The existing Worker remains online as a disabled 410 handler: only `GET /health` responds normally, and old game and AI routes return HTTP 410. Its old KV data is retained. If the handler needs to be redeployed, run [the separate manual Worker workflow](.github/workflows/publish-worker.yml) on `main` or `npm run worker:deploy` with your own Cloudflare credentials. The game does not call the Worker or load media from it.

`BUTLER_API_KEY` is required for itch.io uploads. `CLOUDFLARE_API_TOKEN` is used only by the manual Worker workflow. After an upload, verify the public itch.io project page separately; an upload alone does not establish that anonymous visitors can see it.

## Arena

The combat simulation in `src/sim` runs at a deterministic 60 Hz. Phase rules include the closing ring and breakable pillars. Element mutators add telegraphed arena hazards. After a death, `ruleGrudge` reads the local death log and applies a bounded change to the next retry without a network request.

Historical plans and the original AI architecture are in [the roadmap](docs/ROADMAP.md).
