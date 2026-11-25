import { App, Tags } from "aws-cdk-lib";
import { GithubDeployStack } from "../lib/github-deploy-stack.ts";
import { WebStack } from "../lib/web-stack.ts";

/**
 * Entry point for `cdk synth` / `cdk deploy`.
 * One copy of every stack per environment (dev now, prod from Sprint 6). See docs/02-architecture.md §9.
 */
const app = new App();
const envName = (app.node.tryGetContext("env") as string | undefined) ?? "dev";
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-southeast-1" };

new WebStack(app, `SundoWeb-${envName}`, { env, envName });

// Account-level: lets GitHub Actions deploy the `Sundo*-dev` stacks. Deployed by hand only.
new GithubDeployStack(app, "SundoGithub", {
  env,
  repo: "ElleDiablo/sundo",
  githubEnvironment: "dev",
});

Tags.of(app).add("project", "sundo");
Tags.of(app).add("env", envName);
