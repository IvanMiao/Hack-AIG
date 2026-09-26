import { describe, expect, it } from "vitest";
import { forgeDraftSchema } from "../../src/spec";
import { toGeminiSchema } from "./gemini";

describe("toGeminiSchema", () => {
  it("removes fields Gemini rejects and collapses tuple items", () => {
    const out = JSON.stringify(toGeminiSchema(forgeDraftSchema));
    expect(out).not.toContain("pattern");
    expect(out).not.toContain("additionalProperties");
    const parsed = JSON.parse(out) as { properties: { identity: { properties: { palette: { items: unknown } } } } };
    expect(Array.isArray(parsed.properties.identity.properties.palette.items)).toBe(false);
  });
});

it("turns OpenAPI nullable into a JSON Schema type union", () => {
  expect(toGeminiSchema({ type: "string", enum: ["a", null], nullable: true })).toEqual({ type: ["string", "null"], enum: ["a", null] });
});
