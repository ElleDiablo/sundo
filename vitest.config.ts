/**
 * Root Vitest config: `npm test` runs every project's tests in one go.
 *
 * Each folder listed here has its own vitest.config.ts (a "project") with its own name and
 * settings; Vitest runs them together and reports one total. CI runs the same command.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "infra"],
  },
});
