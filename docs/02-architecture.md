# Sundo: Architecture

**Status:** v0.1 draft · **Last updated:** 2026-11-25 · **Decisions:** see [`adr/`](adr/)

---

## 1. Goals and limits

| Goal | Concretely |
|---|---|
| Real-time co-op for 1–4 seats | Player movement visible to others within ~150 ms in the same region |
| Cost about $0 | Stay in AWS free tier / credits; no service that charges by the hour while idle |
| Real Big Data | Millions of events, columnar storage, SQL over a data lake |
| The monster learns | A nightly job turns history into the tikbalang's knowledge map |
| Professional delivery | Infrastructure as code, CI/CD, least-privilege IAM, alarms |

**Explicit limits:** friends-and-classmates scale (dozens of rooms, not thousands). Cheating
isn't a concern in a co-op game with no rewards (see ADR-0001 for when that would change).

---

## 2. System overview

```mermaid
flowchart TB
    subgraph Players["Players (browser)"]
        H["Host browser<br/>Phaser + engine<br/>runs the simulation"]
        C["Other browsers<br/>Phaser<br/>send input, draw snapshots"]
    end

    subgraph Edge["Static hosting"]
        CF[CloudFront] --> S3W[(S3: game files)]
    end

    subgraph Realtime["Real-time (serverless)"]
        APIGW[API Gateway<br/>WebSocket API] --> LR[Lambda: relay]
        LR --> DDB[(DynamoDB<br/>rooms + connections)]
    end

    subgraph Data["Data lake"]
        RAW[(S3 raw zone<br/>gzip JSON lines)] --> GLUE[Glue Data Catalog]
        CUR[(S3 curated zone<br/>Parquet, by date + source)] --> GLUE
        GLUE --> ATH[Athena]
    end

    subgraph Learn["Nightly learning"]
        EB[EventBridge Scheduler<br/>02:00 PHT] --> LN[Lambda: learner<br/>Python]
        LN --> ATH
        LN --> KM[(S3: knowledge map<br/>+ stats.json)]
    end

    SIM["Simulator (dev laptop)<br/>Node + engine<br/>bots + LLM players"]

    Players -->|load game| CF
    H <-->|wss| APIGW
    C <-->|wss| APIGW
    LR -->|telemetry batches| RAW
    SIM -->|upload batch files| RAW
    SIM -.->|LLM calls| LLM[Gemini / Groq / Claude APIs]
    CF --> KM
```

### The five parts

| Part | Job | AWS services |
|---|---|---|
| **Static hosting** | Serve the game (HTML/JS/art) and the public stats JSON | S3, CloudFront |
| **Real-time relay** | Rooms, joining, passing messages between browsers | API Gateway WebSocket, Lambda, DynamoDB |
| **Data lake** | Store every game event cheaply; query with SQL | S3 (raw + curated zones), Glue Data Catalog, Athena |
| **Nightly learning** | Compact raw → Parquet, then build the knowledge map and stats | EventBridge Scheduler, Lambda (Python), Athena |
| **Simulator** | Play thousands of bot/LLM rounds to generate data | Runs locally; uploads batch files to S3 |

---

## 3. Key idea: one game engine, three places

```mermaid
flowchart LR
    E["packages/engine<br/>pure TypeScript<br/>rules, A*, tikbalang AI<br/>no graphics, no network"]
    E --> CL[Client: host browser<br/>runs it at 20 ticks/s]
    E --> SM[Simulator: Node<br/>runs it as fast as possible]
    E --> T[Unit tests<br/>Vitest]
```

The engine is **deterministic**: same starting seed + same inputs = same result, every time.
- **Fixed time step:** 20 ticks per second (50 ms each), regardless of frame rate.
- **Seeded random numbers:** no `Math.random()` inside the engine.
- **Pure functions:** `step(state, inputs) → { state, events }`. No DOM, no `fetch`, no clock.
- **Whole-number positions (fixed-point):** 1 tile = 1000 units. A player moves 200 units per
  tick (4 tiles/s), or 141 per axis diagonally. Integer maths has no float rounding, so wall
  collision is exact. The client divides by 1000 only when drawing.
- **Collision:** each player is a 0.6 × 0.6-tile box. Movement is applied one axis at a time
  (x, then y), so a blocked diagonal slides along the wall. Outside the map counts as wall.

**Why this matters:**
1. Bots in the simulator play by *exactly* the same rules as people in the browser.
2. Tests are easy: give a state and inputs, check the result.
3. A bug report can include a seed and inputs, so it can be replayed exactly.

Decision record: ADR-0004.

---

## 4. Real-time flow (host-authoritative)

Lambda can't run a continuous game loop (it runs per request and then stops). So the **host's
browser runs the simulation**, and the cloud only **relays** messages. See ADR-0001.

```mermaid
sequenceDiagram
    participant P as Player browser
    participant G as API Gateway (WebSocket)
    participant L as Lambda relay
    participant D as DynamoDB
    participant H as Host browser (engine)

    P->>G: connect + {action:"join", room:"BAHO"}
    G->>L: $connect / join
    L->>D: save connection in room BAHO
    L->>H: player_joined
    loop every input change (≤ 10/s)
        P->>G: {action:"input", keys}
        G->>L: input
        L->>H: postToConnection(input)
    end
    loop every 100 ms
        H->>H: engine.step() × 2 ticks
        H->>G: {action:"snapshot", state}
        G->>L: snapshot
        L->>P: postToConnection(snapshot) to each other player
    end
    Note over P: draws snapshot, smooths movement<br/>between snapshots (interpolation)
    loop every 5 s
        H->>G: {action:"telemetry", events[]}
        G->>L: telemetry
        L->>L: validate + add server timestamp
        L-->>L: S3 PutObject (one gzip JSON-lines file)
    end
```

### WebSocket messages

| Route | From → To | Body | Rate |
|---|---|---|---|
| `$connect` / `$disconnect` | any → server | (none) | once |
| `create_room` | host → server | `{ name, hat, shirt }` | once |
| `join` | player → server → host | `{ room, name, hat, shirt }` | once |
| `input` | player → host | `{ seq, up, down, left, right, light, call, baliktad, emote }` | on change, ≤ 10/s |
| `snapshot` | host → players | `{ tick, players[], kids[], tikbalang, timeLeft }` | 10/s |
| `event` | host → players | `{ type: "caught" \| "kid_home" \| "round_end", ... }` | as they happen |
| `telemetry` | host → server | `{ matchId, events[] }` (max 200) | every 5 s |

**Smoothing:** players see the world ~100 ms in the past and blend between the last two
snapshots. That hides network jitter. It's the standard technique in multiplayer games
(called **snapshot interpolation**).

---

## 5. Data model

### DynamoDB (one table, `sundo-live`)

| PK | SK | Attributes | Purpose |
|---|---|---|---|
| `ROOM#BAHO` | `META` | `hostConnId, status, seed, createdAt, ttl` | Room info |
| `ROOM#BAHO` | `CONN#<connId>` | `name, hat, shirt, seat, joinedAt, ttl` | Who's in the room |
| `CONN#<connId>` | `ROOM` | `room, ttl` | Find the room when someone disconnects |

- **On-demand capacity** (pay per request; tiny at our scale).
- **TTL** deletes rooms 2 hours after creation, so nothing piles up.
- **Concept:** DynamoDB is designed around *how the data will be looked up*. Our only questions are
  "who's in room X?" and "which room is connection Y in?", so the keys match those exactly.

### Event schema (one row per event in the data lake)

| Column | Type | Example |
|---|---|---|
| `event_id` | string (ULID) | `01JDX...` |
| `match_id` | string | `m_01JDX...` |
| `ts` | timestamp | `2026-11-30 21:14:03.250` |
| `tick` | int | `1204` |
| `source` | string | `live` or `sim` |
| `actor_id` | string | `p2`, `tikbalang`, `kid3` |
| `actor_kind` | string | `human`, `bot_bagito`, `bot_beterano`, `llm_gemini`, `tikbalang`, `kid` |
| `event_type` | string | `pos`, `kid_called`, `kid_home`, `caught`, `baliktad`, `light_on`, `emote`, `round_start`, `round_end` |
| `x`, `y` | float | tile coordinates |
| `payload` | string (JSON) | `{"kid":"kid3","house":2}` |
| `engine_version` | string | `0.3.0` |
| `knowledge_version` | string | `2026-11-29` (which map the tikbalang was using) |
| `dt` *(partition)* | string | `2026-11-30` |
| `src` *(partition)* | string | `live` / `sim` |

- `pos` events are sampled **once per second per actor**, not every tick. That's about 12×
  less data with almost no loss for heatmaps. Decision: ADR-0003.
- Lands first in the **raw zone** as gzip JSON lines (one small file per 5 s batch), then the
  nightly job **compacts** each day into a few large **Parquet** files in the **curated zone**
  (columnar, compressed). See ADR-0006.
- Parquet Athena reads only the columns a query needs,
  so a heatmap query touches `x`, `y`, `event_type` and skips the rest.
- Partitioned by **date and source**, so "last 7 days of live games" doesn't scan everything else.

**Volume estimate:** one 6-minute, 4-seat round ≈ 9 actors × 360 position samples ≈ 3,300
position events + ~100 others ≈ **3,400 events**. 1,000 simulated rounds ≈ **3.4 million events**,
about 50–100 MB in Parquet.

### Knowledge map (S3 JSON, written nightly)

```json
{
  "version": "2026-11-29",
  "roundsObserved": 12431,
  "grid": { "w": 48, "h": 32 },
  "pathHeat":  [/* 48*32 numbers, 0..1 */],
  "hideHeat":  [/* ... */],
  "catchHeat": [/* ... */],
  "ambushPoints": [{ "x": 30, "y": 12, "weight": 0.21 }],
  "ambushBias": 0.55
}
```

The game loads `knowledge/latest.json` through CloudFront when a round starts.

---

## 6. Nightly learning job

```mermaid
flowchart LR
    S[02:00 PHT<br/>EventBridge Scheduler] --> L[Lambda: learner<br/>Python + boto3]
    L -->|0. SQL| C[Athena INSERT INTO:<br/>yesterday's raw JSON → curated Parquet]
    C --> A
    L -->|1. SQL| A[Athena:<br/>heat per tile, last 7 days]
    L -->|2. SQL| B[Athena:<br/>win rate by actor_kind]
    A --> M[Pick top ambush tiles,<br/>smooth, normalise]
    B --> M2[Adjust ambushBias<br/>toward 40–60% win rate]
    M --> O[(S3: knowledge/2026-11-29.json<br/>+ latest.json)]
    M2 --> O
    B --> ST[(S3: stats/stats.json<br/>for the Stats page)]
```

Example query (path heat):

```sql
SELECT CAST(floor(x) AS int) AS tx,
       CAST(floor(y) AS int) AS ty,
       count(*)              AS visits
FROM   sundo.events
WHERE  dt >= date_format(current_date - interval '7' day, '%Y-%m-%d')
  AND  event_type = 'pos'
  AND  actor_kind NOT IN ('tikbalang', 'kid')
GROUP  BY 1, 2;
```

The **Stats page** reads the precomputed `stats.json` from CloudFront. It never runs Athena per
visitor, which would be slow and would cost money on every page view.

---

## 7. Simulator and AI players

```mermaid
flowchart LR
    CLI["npm run sim -- --rounds 1000<br/>--seats bagito,beterano,beterano,llm:gemini"] --> R[Round runner]
    R --> E[engine.step]
    R --> P{Seat policy}
    P --> B1[Bagito: nearest kid + A*]
    P --> B2[Beterano: A* avoiding danger]
    P --> Q[Q-learner *stretch*]
    P --> LL[LLM adapter]
    LL --> G[Gemini]
    LL --> GQ[Groq / Llama]
    LL --> CL[Claude via API or Bedrock]
    R --> BUF[One gzip file per 50 rounds] --> S3R[(S3 raw zone)]
```

- Every seat implements one interface: `decide(observation) → intent`.
- **LLM adapter:** turns the observation into a short text description ("You're at (12,8).
  Kid 3 is 6 tiles north-east. Tikbalang last seen at the bridge 4 s ago…"), asks for JSON
  `{ "goal": "kid3" | "home" | "hide", "baliktad": true|false }`, then lets A* do the walking.
- Game time **pauses while an LLM is thinking** (simulator only).
- **API keys stay on the developer's laptop** in `.env` and never ship to the browser.
- Rate-limit handling: back off on HTTP 429, and record `llm_error` events instead of crashing.

---

## 8. Repository layout (npm workspaces monorepo)

```
sundo/
├─ packages/
│  ├─ engine/     # pure TS game rules, A*, tikbalang state machine (+ Vitest tests)
│  ├─ client/     # Phaser 4 + Vite (ADR-0008); lobby, rendering, input, networking
│  ├─ server/     # Lambda handlers (TypeScript): relay, telemetry
├─ learner/       # nightly Lambda (Python): compaction + knowledge map + stats
│  └─ sim/        # Node CLI: round runner, bots, LLM adapters
├─ analytics/     # Athena SQL files + Python notebooks (pandas, matplotlib)
├─ infra/         # AWS CDK app (TypeScript): all stacks
├─ docs/          # this documentation
└─ .github/       # CI/CD workflows, issue + PR templates
```

---

## 9. Infrastructure as code (AWS CDK, TypeScript)

| Stack | Contains |
|---|---|
| `SundoWeb-<env>` | S3 bucket (private), CloudFront with origin access control |
| `SundoRealtime-<env>` | WebSocket API, relay Lambda, DynamoDB table |
| `SundoData-<env>` | Events bucket (raw + curated prefixes), Glue database + 2 tables, Athena workgroup |
| `SundoLearn-<env>` | Scheduler, learner Lambda, knowledge/stats prefixes |
| `SundoOps-<env>` | Budget alarm, CloudWatch alarms, dashboard |
| `SundoGithub` | GitHub OIDC provider + deploy role (one per account, deployed by hand) |

Decision record: ADR-0002.

## 10. CI/CD (GitHub Actions)

```mermaid
flowchart LR
    PR[Pull request] --> CI[lint · typecheck · vitest · cdk synth]
    CI -->|merge| MAIN[main]
    MAIN --> DEV[Deploy to dev<br/>cdk deploy + upload client]
    TAG[Tag v*.*.*] --> PROD[Deploy to prod]
```

- GitHub signs in to AWS with **OIDC**: 1-hour credentials, **no stored access keys** (ADR-0007).
- Only a job in this repo's `dev` GitHub Environment (protected `main` only) can assume the
  deploy role, and that role can only assume the CDK bootstrap roles.
- CI deploys `Sundo*-dev` stacks; the `SundoGithub` stack (OIDC provider + role) is deployed by hand.

---

## 11. Security

| Risk | What we do |
|---|---|
| Leaked AWS keys | No long-lived keys anywhere. I sign in as an IAM user with MFA and use `aws login` for short-lived CLI credentials (IAM Identity Center isn't available on the Free plan); CI uses OIDC |
| Too-broad permissions | Each Lambda has its own role with only the actions it needs (e.g. the relay can't read S3) |
| Spam or floods on the WebSocket | API Gateway throttling (burst 100, 50 req/s); max message 8 KB; max 4 seats per room |
| Fake telemetry | Only the room's host connection can send telemetry; schema validated; max 200 events per batch |
| Abusive chat | No free text (emotes only); room codes filtered (ADR-0005) |
| LLM keys exposed | LLM calls happen only in the simulator on my laptop |
| Public buckets | All buckets private; CloudFront origin access control; S3 Block Public Access on |
| Personal data | No accounts, no emails. Player names are display-only and deleted with the room (TTL) |

## 12. Cost guardrails

| Guardrail | Setting |
|---|---|
| AWS Budgets | `monthly-10-usd`: $10/month, credits and refunds excluded, emails at 85% and 100% actual + 100% forecast. `zero-spend`: emails on any real charge over $0.01 |
| Athena workgroup | Each query limited to scanning 1 GB |
| S3 lifecycle | Raw-zone files deleted 30 days after compaction (Parquet is the copy we keep) |
| No hourly-billed services | **Avoid:** NAT Gateway, Kinesis Data Streams, EC2, App Runner, RDS, Redshift, OpenSearch (several aren't on the Free plan anyway) |
| Lambda | Memory 256 MB; timeouts 5 s (relay) and 60 s (learner) |

**Rough cost at our scale** (after the free tier):
- WebSocket and Lambda: ~$0.01 per 4-player round.
- S3 PUT requests: ~$0.005 per 1,000 files (a 6-minute live round writes ~72).
- Athena: $5 per TB scanned, so our queries cost fractions of a cent.
- S3: cents per month.

**Expected total: under $1 a month, paid from Free-plan credits.** The account is on
the AWS **Free plan** (created 2026-11-19): $100 credits (+ up to $100 more for trying services),
and it **can't charge a card**. It ends after 6 months (~2027-05-19) or when credits run out;
then it must be upgraded to the Paid plan or the account closes. Lambda, DynamoDB, CloudFront and
CloudWatch also have always-free monthly allowances that don't use credits.

## 13. Monitoring
- CloudWatch alarms: relay Lambda errors > 5 in 5 minutes; telemetry S3 write failures > 0;
  learner job failed.
- A CloudWatch dashboard: active connections, messages per minute, events delivered per hour.
- Structured JSON logs with `matchId` and `room`, so one game can be traced end to end.

## 14. What changes at bigger scale

| If… | Then… |
|---|---|
| Strangers play competitively (cheating matters) | Move simulation to a server: GameLift or ECS on Fargate running the same engine |
| 10,000+ rooms | Relay messages per room via a container fleet instead of a Lambda per message |
| Analysts need dashboards | QuickSight on Athena, or load aggregates into Redshift Serverless |
| Events must be processed within seconds | Kinesis Data Streams + Lambda or Managed Flink (Paid plan) |
| Many live games (lots of small files) | Amazon Data Firehose to buffer and convert to Parquet (Paid plan; see ADR-0003) |
| Multiple regions | CloudFront stays global; WebSocket API per region; S3 replication for the data lake |
