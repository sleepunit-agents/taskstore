import { defineConfig } from "vitest/config";

export default defineConfig({
  // A body running these suites has its own conversation in LOOM_BODY_CONVERSATION; the CLI would stamp it on every
  // task it creates (it-ts-source). The suites start without one and set it where they mean to.
  test: { setupFiles: ["test/nudge-isolation.ts"], globalSetup: ["test/build.global.ts"], env: { LOOM_BODY_CONVERSATION: "" } },
});
