import { defineConfig } from "vitest/config";

// itch.io serves the build from a nested path inside an iframe, so every asset URL must be relative.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    // Keep the tuning lab on the dev server; publish only the playable game.
    rollupOptions: { input: "index.html" },
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "worker/**/*.test.ts"],
  },
});
