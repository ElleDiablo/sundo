/**
 * Vitest settings for the engine package (game rules).
 *
 * `defineProject` (instead of `defineConfig`) marks this as one project inside the workspace:
 * the root vitest.config.ts runs every package's tests together, and each package's results are
 * labelled with `name` ("engine") in the output.
 * `environment: "node"` runs the tests in plain Node.js, with no browser APIs (none are needed).
 */
import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "engine", environment: "node" },
});
