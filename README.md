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

The boss specs live in `src/spec/fallback.ts`; baked media is indexed by `src/fallbackAssets.json`. Missing optional media stays unavailable in the offline game. The media-generation scripts remain in the repository for private asset production and require the developer's own API keys. They are not part of the public game or deployed Worker.

## Public release

Every push to `main` runs [the publish workflow](.github/workflows/publish.yml). It builds the static game and uploads it to itch.io. It also replaces the existing Cloudflare Worker with a disabled handler. Only `GET /health` responds normally; all other requests return HTTP 410. The Worker has no provider code or KV binding in its deployment entry point.

The GitHub workflow needs `BUTLER_API_KEY` to publish to itch.io and `CLOUDFLARE_API_TOKEN` to replace the old Worker. **Deploy the disabled Worker before treating the old AI endpoints as closed.** Once deployed, the stored provider secrets can be removed from Cloudflare.

## Arena

The combat simulation in `src/sim` runs at a deterministic 60 Hz. Phase rules include the closing ring and breakable pillars. Element mutators add telegraphed arena hazards. After a death, `ruleGrudge` reads the local death log and applies a bounded change to the next retry without a network request.

Historical plans and the original AI architecture are in [the roadmap](docs/ROADMAP.md).
