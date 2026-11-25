# ADR-0002: AWS CDK in TypeScript for infrastructure

**Status:** Accepted · **Date:** 2026-11-25

## Context
Everything in AWS must be reproducible (dev and prod environments, reviews in PRs). The rest of
the project is TypeScript.

## Options considered
1. **Click in the console**: fast once, impossible to review or repeat.
2. **AWS SAM**: simple YAML, great for Lambda-only apps; weaker for CloudFront, Firehose, Glue.
3. **Terraform**: popular and multi-cloud; another language (HCL) and state file to manage.
4. **AWS CDK (TypeScript)**: real code with types and loops; produces CloudFormation; same
   language as the game.

## Decision
CDK in TypeScript, one stack per area (Web, Realtime, Data, Learn, Ops), parameterised by environment.

## Consequences
- Good: one language across the repo; IAM permissions generated with `grant*` helpers
  (least privilege by default); `cdk diff` in PRs shows infrastructure changes.
- Bad: CDK needs a one-time `cdk bootstrap`; CloudFormation can be slow to deploy.
- SAM and Terraform would also work; CDK was chosen for one-language consistency.
