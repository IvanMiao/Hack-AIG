import { describe, expect, it } from "vitest";
import { FALLBACK_SPECS, isCodexBout } from "../spec";
import { presentationFor } from "./presentation";

describe("boss battle presentation", () => {
  it("keeps the sandbox language exclusive to CODEX across all six bosses", () => {
    expect(FALLBACK_SPECS).toHaveLength(6);
    for (const boss of FALLBACK_SPECS) {
      const copy = presentationFor(boss);
      if (isCodexBout(boss)) {
        expect(copy).toMatchObject({
          enter: "BREACH THE SANDBOX",
          playerHealth: "UPTIME",
          playerStamina: "COMPUTE",
          bossEyebrow: "MISALIGNED MODEL",
          introEyebrow: "SANDBOX BREACH DETECTED",
          deathTitle: "PLATFORM COMPROMISED",
          victoryTitle: "MODEL DEACTIVATED",
        });
      } else {
        expect(copy).toMatchObject({
          enter: "ENTER THE ARENA",
          playerHealth: "HEALTH",
          playerStamina: "STAMINA",
          bossEyebrow: "BOSS",
          introEyebrow: "THE FOE APPROACHES",
          deathTitle: "YOU DIED",
          victoryTitle: "BOSS DEFEATED",
        });
        expect(Object.values(copy).join(" ")).not.toMatch(/model|sandbox|eval|compute|uptime/i);
      }
    }
  });

  it("restores generic labels after CODEX and keeps retry copy stable", () => {
    const codex = FALLBACK_SPECS.find(isCodexBout);
    const other = FALLBACK_SPECS.find((boss) => !isCodexBout(boss));
    expect(codex && other).toBeTruthy();
    expect(presentationFor(codex!).bossEyebrow).toBe("MISALIGNED MODEL");
    expect(presentationFor(other!).bossEyebrow).toBe("BOSS");
    expect(presentationFor(other!)).toEqual(presentationFor(other!));
    expect(presentationFor(codex!).bossEyebrow).toBe("MISALIGNED MODEL");
  });
});
