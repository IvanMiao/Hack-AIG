import { describe, expect, it } from "vitest";
import worker from "./index";

const url = (path: string) => `https://nemesis-forge.example${path}`;

describe("disabled public Worker", () => {
  it("keeps a read-only health check", async () => {
    const response = await worker.fetch(new Request(url("/health")));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, mode: "offline" });
  });

  it("refuses every former API route before reading a request body or provider binding", async () => {
    for (const [method, path] of [
      ["POST", "/forge"],
      ["POST", "/forge/asset"],
      ["POST", "/learn"],
      ["POST", "/voice-token"],
      ["GET", "/nemesis/CODEX-01"],
      ["GET", "/asset/CODEX-01/voice-intro"],
      ["GET", "/lineage/CODEX-01"],
      ["POST", "/lineage/CODEX-01"],
      ["OPTIONS", "/forge"],
    ] as const) {
      const response = await worker.fetch(new Request(url(path), { method }));
      expect(response.status, `${method} ${path}`).toBe(410);
      expect(await response.json()).toEqual({ error: "service disabled" });
    }
  });
});
