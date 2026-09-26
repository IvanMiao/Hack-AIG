---
name: nemesis-runtime-testing
description: Run Nemesis locally and verify death, evolution, and retry through normal gameplay.
---

# Local runtime testing

- Start Vite with `npm run dev -- --host 0.0.0.0`; browser URL is http://localhost:5173.
- Start Worker with `npm run worker:dev` on :8787. Vite proxies `/api` to it.
- When no `.dev.vars` exists, Wrangler supports `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` to read injected API credentials without writing plaintext secrets. This includes all process environment variables; use a constrained environment where practical.
- Click **Use a bound nightmare**, then **ENTER THE RIFT** if the ritual has not auto-entered. Asset failures do not prevent combat.
- Standing still typically dies in 10–20 seconds. WASD moves, J/K attacks and Space rolls; attacks are edge-triggered.
- To check real local fallback, stop Worker while keeping Vite running. Failed `/api/learn` should still produce a complete GRUDGE and generation-labeled retry.
- Test both immediate failures and requests taking longer than the death-screen delay. Read-only MutationObserver and fetch timing capture can distinguish hidden result updates from visible rendering.
- Verify evolved spec by capturing the next death's actual POST body: unchanged identity/code, incremented lineage generation, tuned or added move, and expected taunt changes. Do not modify game state to manufacture victory.
- Report expected offline asset/network warnings separately from uncaught exceptions.

## Devin Secrets Needed

- GEMINI_API_KEY: Worker text/image generation.
- GRADIUM_API_KEY: voice assets.
- No credentials required for bound-nightmare/local-fallback testing.
