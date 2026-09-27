import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import { mintForgeToken, verifyForgeToken } from "./forgeToken";
import { consume, RATE_LIMITS } from "./rateLimit";

function fakeEnv(): Env {
  const store = new Map<string, string>();
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
  } as unknown as KVNamespace;
  return { NEMESIS_KV: kv, GEMINI_API_KEY: "test-gemini-key", GRADIUM_API_KEY: "g", GEMINI_TEXT_MODEL: "", GEMINI_IMAGE_MODEL: "", MUSIC_PROVIDER: "lyria", ALLOWED_ORIGINS: "" };
}

describe("consume", () => {
  it("allows up to the limit in a window, then refuses until the window rolls over", async () => {
    const env = fakeEnv();
    const { limit, windowSeconds } = RATE_LIMITS.forge;
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < limit; i += 1) expect((await consume(env, "forge", "1.2.3.4", t0)).allowed).toBe(true);
    const refused = await consume(env, "forge", "1.2.3.4", t0);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
    expect((await consume(env, "forge", "1.2.3.4", t0 + windowSeconds * 1000)).allowed).toBe(true);
  });

  it("keeps buckets and subjects independent", async () => {
    const env = fakeEnv();
    for (let i = 0; i < RATE_LIMITS.lineage.limit; i += 1) await consume(env, "lineage", "a");
    expect((await consume(env, "lineage", "a")).allowed).toBe(false);
    expect((await consume(env, "lineage", "b")).allowed).toBe(true);
    expect((await consume(env, "lineageCode", "a")).allowed).toBe(true);
  });
});

describe("forge token", () => {
  it("verifies only the token minted for that code, case-insensitively", async () => {
    const env = fakeEnv();
    const token = await mintForgeToken(env, "abcd1234");
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifyForgeToken(env, "ABCD1234", token)).toBe(true);
    expect(await verifyForgeToken(env, "abcd1235", token)).toBe(false);
    expect(await verifyForgeToken(env, "abcd1234", token.slice(1) + "0")).toBe(false);
    expect(await verifyForgeToken(env, "abcd1234", undefined)).toBe(false);
    expect(await verifyForgeToken({ ...env, FORGE_TOKEN_SECRET: "other" }, "abcd1234", token)).toBe(false);
  });
});
