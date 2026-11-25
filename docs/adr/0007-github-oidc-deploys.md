# ADR-0007: GitHub Actions deploys with OIDC, through the CDK bootstrap roles

**Status:** Accepted · **Date:** 2026-11-25

## Context
Merging to `main` should deploy the `dev` environment automatically. The pipeline needs AWS
credentials, and the usual shortcut, an IAM user's access key stored as a GitHub secret, is a
long-lived credential that never expires, skips MFA, and is easy to leak.

## Options considered
1. **Access key in GitHub secrets**: simplest, but a permanent key outside AWS. Rejected.
2. **OIDC role with direct CloudFormation permissions on `Sundo*` stacks only**: tight on paper, but
   CloudFormation still runs as the bootstrap execution role, so the real blast radius barely changes,
   and the CDK CLI has to fall back from its normal role chain.
3. **OIDC role that can only assume the CDK bootstrap roles** (deploy, file-publishing,
   image-publishing, lookup): the standard CDK pattern.

## Decision
Option 3, defined in the `SundoGithub` stack:
- An IAM OIDC provider trusts tokens from `token.actions.githubusercontent.com` for audience `sts.amazonaws.com`.
- Role `sundo-github-deploy-dev` trusts only the exact subject
  `repo:ElleDiablo/sundo:environment:dev` (no wildcards), with 1-hour sessions.
- The GitHub Environment `dev` accepts only protected branches (`main`), so pull requests and
  forks can never obtain credentials.
- The role's only permission is `sts:AssumeRole` on the four bootstrap roles.
- The workflow deploys `Sundo*-dev` stacks only. `SundoGithub` itself is deployed by hand,
  so a workflow change can't widen its own access.

## Consequences
- Good: no AWS keys exist anywhere; credentials last an hour and are tied to one repo, environment
  and branch; trust rules are covered by unit tests.
- Bad: the bootstrap CloudFormation execution role still has `AdministratorAccess` (the CDK
  default), so anything merged to `main` can create any resource. Branch protection and review are
  the control today.
- **Revisit when:** `prod` arrives (Sprint 6): re-bootstrap with a scoped execution policy
  (`cdk bootstrap --cloudformation-execution-policies`) listing only the services Sundo uses, and
  add a `prod` Environment with required reviewers.
