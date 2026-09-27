import { isCodexBout, type NemesisSpec } from "../spec";

/** Shared fight UI copy. CODEX keeps its original sandbox story. */
export function presentationFor(spec: Pick<NemesisSpec, "code">) {
  return isCodexBout(spec) ? {
    enter: "BREACH THE SANDBOX",
    playerHealth: "UPTIME",
    playerHealthAria: "Player uptime",
    playerStamina: "COMPUTE",
    playerStaminaAria: "Player compute",
    bossEyebrow: "MISALIGNED MODEL",
    bossHealthAria: "Model uptime",
    bossPoiseAria: "Model poise",
    introEyebrow: "SANDBOX BREACH DETECTED",
    deathTitle: "PLATFORM COMPROMISED",
    victoryTitle: "MODEL DEACTIVATED",
  } : {
    enter: "ENTER THE ARENA",
    playerHealth: "HEALTH",
    playerHealthAria: "Player health",
    playerStamina: "STAMINA",
    playerStaminaAria: "Player stamina",
    bossEyebrow: "BOSS",
    bossHealthAria: "Boss health",
    bossPoiseAria: "Boss poise",
    introEyebrow: "THE FOE APPROACHES",
    deathTitle: "YOU DIED",
    victoryTitle: "BOSS DEFEATED",
  };
}
