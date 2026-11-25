import { App, Tags } from "aws-cdk-lib";
import { WebStack } from "../lib/web-stack.ts";

/**
 * Entry point for `cdk synth` / `cdk deploy`.
 * One copy of every stack per environment (dev now, prod from Sprint 6). See docs/02-architecture.md §9.
 */
const app = new App();
const envName = (app.node.tryGetContext("env") as string | undefined) ?? "dev";
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-southeast-1" };

new WebStack(app, `SundoWeb-${envName}`, { env, envName });

Tags.of(app).add("project", "sundo");
Tags.of(app).add("env", envName);
