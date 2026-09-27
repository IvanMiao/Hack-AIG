import { describe, expect, it } from "vitest";
import type { Env } from "./env";
import { corsHeaders } from "./http";

const env = { ALLOWED_ORIGINS: "http://localhost:5173, https://html.itch.zone" } as Env;
const acao = (origin?: string) =>
  new Headers(corsHeaders(new Request("https://x/api", { headers: origin ? { origin } : {} }), env)).get("access-control-allow-origin");

describe("corsHeaders", () => {
  it("reflects only exact allowlisted origins", () => {
    expect(acao("https://html.itch.zone")).toBe("https://html.itch.zone");
    expect(acao("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("does not reflect same-zone or lookalike origins", () => {
    for (const o of ["https://evil.pages.dev", "https://evil.itch.zone", "http://html.itch.zone", "https://html.itch.zone.evil.com", ""]) {
      expect(acao(o || undefined)).toBe("http://localhost:5173");
    }
  });
});
