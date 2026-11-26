import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/acceptance/**/*.acceptance.test.ts"],
    environment: "node",
  },
});
