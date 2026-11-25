/**
 * Vitest settings for the infrastructure tests.
 *
 * These tests build each CDK stack into a CloudFormation template and check it (no AWS account
 * needed). Building the relay stack also bundles the Lambda with esbuild, which can take a few
 * seconds on a cold machine, hence the longer 60 s timeout.
 */
import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "infra", environment: "node", testTimeout: 60_000 },
});
