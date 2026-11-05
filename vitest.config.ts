import { defineConfig } from "vitest/config";

// Many tests spawn real git, which can take 100+ ms per call on macOS; keep headroom.
// NOWALL_NO_LAUNCHD: tests (and the CLIs they spawn) never call launchctl, pgrep or pkill, so the
// user's live notch is never touched.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    env: { NOWALL_NO_LAUNCHD: "1" },
  },
});
