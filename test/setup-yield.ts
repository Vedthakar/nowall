import { afterEach } from "vitest";

// Most tests spawn real processes synchronously, and consecutive tests run without returning to
// the event loop. Yield after each one so vitest's own progress messages aren't starved.
afterEach(() => new Promise((resolve) => setImmediate(resolve)));
