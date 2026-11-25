# ADR-0003: Firehose → S3 Parquet → Athena for analytics

**Status:** Superseded by [ADR-0006](0006-s3-direct-writes-nightly-compaction.md) · **Date:** 2026-11-25

## Context
We expect millions of small events (live games + simulator). We need cheap storage, SQL
queries once a night and for exploration, and no idle costs.

## Options considered
1. **Write events to DynamoDB**: great for lookups by key, poor and pricey for scanning millions of rows.
2. **Kinesis Data Streams + consumers**: real-time within seconds, but billed per shard-hour even when idle.
3. **RDS / Redshift**: real SQL databases, but billed per hour.
4. **Kinesis Data Firehose → S3 (Parquet) → Glue catalog → Athena**: pay per GB delivered and
   per TB scanned; nothing to run; standard "data lake" pattern.

## Decision
Option 4. Firehose buffers up to 5 MB or 300 s, converts JSON to Parquet using the Glue table
schema, and writes to `s3://.../events/dt=YYYY-MM-DD/src=live|sim/`. Position samples are taken
once per second per actor, not every tick.

## Consequences
- Good: costs cents; columnar Parquet + partitions mean queries scan very little; scales to billions of rows.
- Bad: data arrives in the lake up to ~5 minutes late (fine for nightly learning).
- Hot/cold split: live room state stays in DynamoDB (hot), history goes to S3 (cold).
- **Revisit when:** something must react to events within seconds (then Kinesis Data Streams or Managed Flink).
