# Architecture Decision Records (ADRs)

An ADR is a short note that records **one** important decision: the situation, the options,
what we chose, and what we give up. Teams write them so that, months later, nobody has to guess
*why* something is built the way it is. They're never edited after acceptance; if a decision
changes, write a new ADR that **supersedes** the old one.

| # | Decision | Status |
|---|---|---|
| [0001](0001-host-authoritative-networking.md) | Host's browser runs the game; the cloud only relays | Accepted |
| [0002](0002-aws-cdk-typescript.md) | AWS CDK in TypeScript for infrastructure | Accepted |
| [0003](0003-firehose-parquet-athena.md) | Firehose → S3 Parquet → Athena for analytics | Superseded by 0006 |
| [0004](0004-shared-deterministic-engine.md) | One deterministic engine shared by browser, simulator and tests | Accepted |
| [0005](0005-emotes-not-chat.md) | Emotes only, no free-text chat | Accepted |
| [0006](0006-s3-direct-writes-nightly-compaction.md) | Write raw events straight to S3; compact to Parquet nightly | Accepted |
| [0007](0007-github-oidc-deploys.md) | GitHub Actions deploys with OIDC through the CDK bootstrap roles | Accepted |

Template: copy `0000-template.md`.
