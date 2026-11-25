# ADR-0006: Write raw events straight to S3; compact to Parquet nightly

**Status:** Accepted · **Supersedes:** [ADR-0003](0003-firehose-parquet-athena.md) · **Date:** 2026-11-25

## Context
ADR-0003 chose Amazon Data Firehose. Our AWS account (created 2026-11-19) is on the **Free plan**,
and Firehose is a **Paid-plan-only** service. S3, Glue, Athena, Lambda and EventBridge are all
available on the Free plan. We don't want to upgrade (the Free plan can't charge a card).

## Options considered
1. **Upgrade to the Paid plan and keep Firehose**: simplest pipeline, but removes the no-charge safety net; irreversible.
2. **Write to DynamoDB, export to S3 nightly**: extra moving parts and DynamoDB write costs.
3. **Write gzip JSON-lines files straight to S3 (raw zone), then compact nightly into Parquet
   (curated zone) with an Athena `INSERT INTO ... SELECT`.**

## Decision
Option 3.
- Telemetry Lambda: one `PutObject` per 5-second batch → `raw/dt=YYYY-MM-DD/src=live/<matchId>-<seq>.json.gz`.
- Simulator: one file per 50 rounds → `raw/dt=.../src=sim/`.
- Nightly learner (Python): `INSERT INTO events SELECT ... FROM events_raw WHERE dt = <yesterday>`
  writes Parquet to `curated/`, then runs the knowledge-map queries on `curated/` only.

## Consequences
- Good: stays on the Free plan; one extra step teaches the **raw → curated zone** (bronze → silver)
  pattern and the **small-files problem**, both core data-engineering patterns.
- Bad: we manage compaction ourselves; data reaches the curated zone once a day (fine for nightly learning).
- Many tiny raw files are slow to query, which is exactly why we compact and only query `curated/`.
- **Revisit when:** we upgrade to the Paid plan and live traffic grows; then Firehose (ADR-0003) is the better fit.
