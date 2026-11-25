# ADR-0001: The host's browser runs the game; the cloud only relays

**Status:** Accepted · **Date:** 2026-11-25

## Context
A real-time game needs something to run the simulation 20 times a second (move players,
run the tikbalang, check catches). AWS Lambda only runs per request and then stops, so it
can't run a continuous loop. Budget is about $0, and the audience is friends, not strangers.

## Options considered
1. **Dedicated game server** (ECS on Fargate, EC2, or GameLift): authoritative and cheat-proof,
   but billed per hour while running, even with nobody playing. Adds container ops work.
2. **Lambda per tick** (e.g. a Step Functions loop): technically possible, but slow, costly
   per invocation and awkward.
3. **Host-authoritative**: the room creator's browser runs the shared engine; other players
   send inputs to the host through a serverless WebSocket relay; the host broadcasts snapshots.

## Decision
Option 3. API Gateway WebSocket + Lambda relay + DynamoDB for room membership.

## Consequences
- Good: no idle cost; fully serverless; reuses the same engine as the simulator (ADR-0004).
- Bad: the host could cheat (doesn't matter in co-op with no rewards); if the host leaves, the
  round ends (host migration is a later story); the host's connection quality affects everyone.
- Cost: each relayed message is a Lambda call + API Gateway message, ~12k per 4-player round,
  roughly $0.01. Fine for dozens of rooms.
- **Revisit when:** strangers play competitively, or rooms exceed ~1,000/day. Then run the same
  engine on GameLift or ECS on Fargate.
