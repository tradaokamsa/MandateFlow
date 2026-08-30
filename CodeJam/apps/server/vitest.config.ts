import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 10_000,
  },
});
