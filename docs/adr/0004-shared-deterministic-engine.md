# ADR-0004: One deterministic engine shared by browser, simulator and tests

**Status:** Accepted · **Date:** 2026-11-25

## Context
The same rules must run in the host's browser, in the Node simulator (thousands of rounds), and
in unit tests. If bots played by slightly different rules, the data lake would teach the
tikbalang the wrong lessons.

## Options considered
1. **Game logic inside Phaser scenes**: quickest at first; can't run without a browser; hard to test.
2. **Separate copies for client and simulator**: they'd drift apart over time.
3. **A pure TypeScript `engine` package**: `step(state, inputs) → { state, events }`, fixed 50 ms
   ticks, seeded random numbers, no DOM, network or clock.

## Decision
Option 3. Phaser only draws and reads the keyboard; the engine owns every rule.

## Consequences
- Good: easy tests; simulator speed (no rendering); exact replays from a seed + inputs.
- Bad: more discipline up front (no `Math.random()`, no `Date.now()` inside the engine).
- Lint rule bans those calls inside `packages/engine`.
