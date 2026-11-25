# ADR-0008: Phaser 4 for the browser client

**Status:** Accepted · **Date:** 2026-11-25

## Context
The architecture doc planned "Phaser 3 + Vite" for the client. When the client package was
created (S1-01), Phaser 4 was the current stable release (4.2.1) and Phaser 3 was the previous
major version, receiving fixes only. The client draws a Tiled map, sprites, a following camera and,
from Sprint 3, coloured lights and a flashlight cone (the "lit pixel art" look).

## Options considered
1. **Phaser 3**: the most tutorials and answered questions online. But it's the previous major
   version, and its lighting pipeline is the part Phaser 4 replaced.
2. **Phaser 4**: the maintained version, with a new WebGL renderer (render nodes), filters that
   work on any object or camera, and reworked lighting. The everyday API this game uses (scenes,
   loader, Tiled tilemaps, cameras, keyboard input) is unchanged from Phaser 3.
3. **No framework** (canvas or WebGL by hand): full control, but tilemaps, cameras, input and
   asset loading would all be rebuilt for no gain.

## Decision
Phaser 4 (option 2), with Vite as the dev server and bundler. Game rules stay in
`packages/engine` (ADR-0004); Phaser only reads input and draws.

## Consequences
- Good: a maintained renderer; lighting and filters fit the planned look without custom pipelines.
- Good: the basics carry over from Phaser 3, and Phaser ships migration notes in its package.
- Bad: fewer examples online are written for v4; older answers may use APIs that were removed
  (pipelines, `setTintFill`, BitmapMask), so v4's own docs come first.
- Revisit if a feature the game needs turns out to be missing or broken in v4.
