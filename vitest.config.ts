import { defineConfig } from "vitest/config";

// Many tests spawn real git, which can take 100+ ms per call on macOS; keep headroom.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });
