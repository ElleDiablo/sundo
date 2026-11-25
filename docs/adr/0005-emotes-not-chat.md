# ADR-0005: Emotes only, no free-text chat

**Status:** Accepted · **Date:** 2026-11-25

## Context
Players need to coordinate ("over here!", "run!"). Free-text chat in a public game needs
moderation, reporting and storage of personal messages.

## Options considered
1. **Free-text chat with a word filter**: flexible, but filters are easy to dodge and we'd store user messages.
2. **Free-text chat + an AI moderation service**: costs money; still needs a reporting flow.
3. **Fixed emotes** (Dito! / Takbo! / Tulong! / Salamat!).

## Decision
Option 3 for v1.

## Consequences
- Good: no moderation or personal-data burden; bots and LLM players can use emotes too; faster
  to use in a scary moment.
- Bad: less expressive; friends will use Discord voice anyway.
- **Revisit when:** there's a reason to add accounts and reporting.
