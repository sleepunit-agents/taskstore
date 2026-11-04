import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { globalSetup: ["test/build.global.ts"] },
});
