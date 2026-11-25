/**
 * Vitest settings for the client package (only its pure logic, like the fixed timestep).
 *
 * `defineProject` (instead of `defineConfig`) marks this as one project inside the workspace:
 * the root vitest.config.ts runs every package's tests together, and each package's results are
 * labelled with `name` ("client") in the output.
 * `environment: "node"` runs the tests in plain Node.js, with no browser APIs (none are needed).
 */
import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "client", environment: "node" },
});
