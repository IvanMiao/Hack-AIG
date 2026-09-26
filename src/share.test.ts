import { describe, expect, it } from "vitest";
import { codeFromSearch, lineageLine, normalizeCode, shareText, shareUrl } from "./share";
import { getFallbackSpec } from "./spec";

describe("share codes", () => {
  it("normalizes typed codes to the Worker's code pattern", () => {
    expect(normalizeCode(" ab12cd34 ")).toBe("AB12CD34");
    expect(normalizeCode("ab 12-cd")).toBe("AB12-CD");
    expect(normalizeCode("ab")).toBeNull();
    expect(normalizeCode("x".repeat(17))).toBeNull();
  });

  it("reads the code from the share query and ignores garbage", () => {
    expect(codeFromSearch("?n=ab12cd34&x=1")).toBe("AB12CD34");
    expect(codeFromSearch("?n=!!")).toBeNull();
    expect(codeFromSearch("")).toBeNull();
  });

  it("deep links on a direct host and falls back to the itch page inside the embed", () => {
    const direct = { origin: "https://example.com", pathname: "/nemesis/", hostname: "example.com" };
    expect(shareUrl(direct, "AB12CD34", undefined)).toBe("https://example.com/nemesis/?n=AB12CD34");
    const embed = { origin: "https://html.itch.zone", pathname: "/html/123/index.html", hostname: "html.itch.zone" };
    expect(shareUrl(embed, "AB12CD34", undefined)).toBe("https://ivanmiao.itch.io/nemesis");
    expect(shareUrl(embed, "AB12CD34", "https://play.example.com/")).toBe("https://play.example.com/?n=AB12CD34");
  });

  it("renders lineage and share text", () => {
    expect(lineageLine({ gen: 1, kills: 0, victories: 0 })).toBe("GEN 1 · 0 summoners slain");
    expect(lineageLine({ gen: 3, kills: 1, victories: 1 })).toBe("GEN 3 · 1 summoner slain · felled once");
    expect(lineageLine({ gen: 4, kills: 7, victories: 2 })).toBe("GEN 4 · 7 summoners slain · felled 2 times");
    const spec = getFallbackSpec();
    const text = shareText(spec, { gen: 2, kills: 3, victories: 0 }, "https://x.test/?n=CODE");
    expect(text).toContain(spec.identity.name);
    expect(text).toContain(spec.code);
    expect(text).toContain("slain 3 summoners");
    expect(text.endsWith("https://x.test/?n=CODE")).toBe(true);
  });
});
