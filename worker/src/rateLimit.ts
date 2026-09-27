import type { Env } from "./env";

/** Fixed-window counters in KV. Approximate (KV is eventually consistent), which is enough to cap abuse of paid generation. */
export interface RateLimitRule { limit: number; windowSeconds: number }

export const RATE_LIMITS = {
  forge: { limit: 6, windowSeconds: 60 },
  asset: { limit: 16, windowSeconds: 60 },
  /** Uncached voice renders per code: the client-supplied script is the one input the cache cannot dedupe. */
  voiceBuild: { limit: 3, windowSeconds: 3600 },
  learn: { limit: 10, windowSeconds: 60 },
  voiceToken: { limit: 6, windowSeconds: 60 },
  lineage: { limit: 6, windowSeconds: 60 },
  lineageCode: { limit: 30, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

export interface RateLimitVerdict { allowed: boolean; retryAfterSeconds: number }

export const clientIp = (request: Request): string =>
  request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? "unknown";

const MIN_KV_TTL_SECONDS = 60;

export async function consume(env: Env, bucket: RateLimitBucket, subject: string, now = Date.now()): Promise<RateLimitVerdict> {
  const { limit, windowSeconds } = RATE_LIMITS[bucket];
  const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
  const retryAfterSeconds = windowStart + windowSeconds - Math.floor(now / 1000);
  const key = `rl:${bucket}:${subject}:${windowStart}`;
  const count = Number((await env.NEMESIS_KV.get(key)) ?? 0);
  if (count >= limit) return { allowed: false, retryAfterSeconds };
  await env.NEMESIS_KV.put(key, String(count + 1), { expirationTtl: Math.max(MIN_KV_TTL_SECONDS, retryAfterSeconds + MIN_KV_TTL_SECONDS) });
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Per-IP limit for a route; `subject` overrides the IP when the scarce thing is a code rather than a caller. */
export async function rateLimit(env: Env, request: Request, bucket: RateLimitBucket, subject = clientIp(request)): Promise<RateLimitVerdict> {
  return consume(env, bucket, subject);
}
