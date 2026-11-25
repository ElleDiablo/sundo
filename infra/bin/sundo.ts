import { App, Tags } from "aws-cdk-lib";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GithubDeployStack } from "../lib/github-deploy-stack.ts";
import { WebStack } from "../lib/web-stack.ts";

/**
 * Entry point for `cdk synth` / `cdk deploy`.
 * One copy of every stack per environment (dev now, prod from Sprint 6). See docs/02-architecture.md §9.
 */
const app = new App();
const envName = (app.node.tryGetContext("env") as string | undefined) ?? "dev";
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-southeast-1" };

// The website is the client's production build. Build it first: npm run build -w @sundo/client
const siteDir = fileURLToPath(new URL("../../packages/client/dist", import.meta.url));
if (!existsSync(`${siteDir}/index.html`)) {
  throw new Error(`No client build at ${siteDir}. Run: npm run build -w @sundo/client`);
}
new WebStack(app, `SundoWeb-${envName}`, { env, envName, siteDir });

// Account-level: lets GitHub Actions deploy the `Sundo*-dev` stacks. Deployed by hand only.
new GithubDeployStack(app, "SundoGithub", {
  env,
  repo: "ElleDiablo/sundo",
  oidcSubjectPrefix: "repo:ElleDiablo@100169794/sundo@1471471072",
  githubEnvironment: "dev",
});

Tags.of(app).add("project", "sundo");
Tags.of(app).add("env", envName);
