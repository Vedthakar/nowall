import { defineConfig } from "vitest/config";

// Many tests spawn real git, which can take 100+ ms per call on macOS; keep headroom.
// NOWALL_NO_LAUNCHD: tests (and the CLIs they spawn) never call launchctl, pgrep or pkill, so the
// user's live notch is never touched.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 60_000,
    // Each worker spawns many real processes; too many at once starves vitest's own messaging.
    poolOptions: { forks: { maxForks: 4 } },
    env: { NOWALL_NO_LAUNCHD: "1" },
    // Long synchronous spawns can delay vitest's own progress messages past its 60 s limit. That
    // says nothing about the code under test; real failures and other errors still fail the run.
    onUnhandledError: (error) => !error.message?.includes('Timeout calling "onTaskUpdate"'),
  },
});
