import { defineConfig } from "vitest/config";

// Many tests spawn real git, which can take 100+ ms per call on macOS; keep headroom.
// NOWALL_NO_LAUNCHD: tests (and the CLIs they spawn) never call launchctl, pgrep or pkill, so the
// user's live notch is never touched.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup-yield.ts"],
    testTimeout: 60_000,
    // Each worker spawns many real processes; too many at once starves vitest's own messaging.
    poolOptions: { forks: { maxForks: 4 } },
    env: { NOWALL_NO_LAUNCHD: "1" },
  },
});
