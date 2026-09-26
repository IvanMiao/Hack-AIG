import { describe, expect, it } from "vitest";
import { BOSS_MODEL_URLS, materialRole } from "./assets";
import { SILHOUETTES } from "../spec/types";

describe("materialRole", () => {
  it("matches runtime material roles and Blender suffixes", () => {
    expect(materialRole("accent")).toBe("accent");
    expect(materialRole("accent.001")).toBe("accent");
    expect(materialRole("stone_dark.12")).toBe("stone_dark");
    expect(materialRole("unknown")).toBeNull();
  });
});

describe("boss model URLs", () => {
  it("provides a model for every silhouette", () => {
    for (const silhouette of SILHOUETTES) {
      expect(BOSS_MODEL_URLS[silhouette]).toBeTruthy();
    }
  });
});
