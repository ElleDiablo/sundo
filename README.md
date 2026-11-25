# Sundo

[![CI](https://github.com/ElleDiablo/sundo/actions/workflows/ci.yml/badge.svg)](https://github.com/ElleDiablo/sundo/actions/workflows/ci.yml)

> During a brownout in a rural Philippine barangay, five children are lost in the dark.
> Work together to bring them home before dawn, while a **tikbalang that learns from every game
> ever played** waits on the paths you always take.

A co-op multiplayer pixel horror game in the browser, built on AWS serverless, with a data lake
that teaches the monster. Humans, classic AI bots and LLM players share the same world.

**Status:** Sprint 0 (foundations) · **Live:** [d2k0lzzbi69b8k.cloudfront.net](https://d2k0lzzbi69b8k.cloudfront.net) (placeholder page)

## Highlights
- **Real-time multiplayer, fully serverless:** API Gateway WebSockets + Lambda + DynamoDB, with
  the host's browser running the simulation (no game servers billed by the hour).
- **Big Data loop:** every game event lands in an S3 data lake (raw JSON → curated Parquet,
  compacted nightly); Athena turns the history into the tikbalang's nightly "knowledge map".
- **Humans vs bots vs LLMs:** one deterministic engine runs in the browser, in tests and in a
  simulator that plays thousands of rounds with A* bots and LLM players.
- **Engineered like production:** infrastructure as code (AWS CDK), architecture decision records,
  CI on every pull request, keyless deploys with GitHub OIDC, budgets and least-privilege IAM.

## Architecture
See [docs/02-architecture.md](docs/02-architecture.md) for diagrams, the data model, security
and cost, and [docs/adr/](docs/adr/) for why each choice was made.

| Layer | AWS services |
|---|---|
| Web | S3 (private) + CloudFront (origin access control) |
| Real-time | API Gateway WebSocket, Lambda, DynamoDB (TTL) |
| Data lake | S3 raw → curated (Parquet), Glue Data Catalog, Athena |
| Learning | EventBridge schedule → Python Lambda → Athena → `knowledge/latest.json` |
| Ops | CloudWatch alarms and dashboard, AWS Budgets |

## Repo layout
```
packages/engine   deterministic game engine (TypeScript, no I/O)
infra/            AWS CDK app (TypeScript)
docs/             game design, architecture, ADRs
```
More packages (`client`, `server`, `sim`, `learner`) are added as the sprints reach them.

## Run it locally
Requires Node 26 (see `.nvmrc`).
```
npm ci
npm run lint && npm run typecheck && npm test
npm run synth -w infra     # build the CloudFormation templates (no AWS account needed)
```

## Docs
| Doc | What's in it |
|---|---|
| [Game design](docs/01-game-design.md) | Rules, characters, map, the learning loop |
| [Architecture](docs/02-architecture.md) | AWS design, data model, security, cost |
| [Decisions (ADRs)](docs/adr/) | Why it's built this way |

## Author
Built by **Judelle Gaza** ([@ElleDiablo](https://github.com/ElleDiablo)).
