/**
 * Path-finding on the tile grid (S3-02): how the tikbalang walks around walls.
 *
 * Breadth-first search (BFS): starting from my tile, visit every neighbour, then their neighbours,
 * and so on, ring by ring, remembering where each tile was reached from. The first time the goal
 * is reached, that's a shortest path (in steps). Walking back along "reached from" gives the
 * first step to take. The map is 48 × 32 = 1536 tiles, so a full search is a few thousand simple
 * operations: cheap enough to redo every tick, which means the path always follows a moving target.
 *
 * Only 4 neighbours (no diagonals), always in the same order (right, left, down, up), so ties are
 * broken the same way on every machine: the same inputs always give the same path (ADR-0004).
 * Moving between the centres of two neighbouring open tiles never touches a wall, because the two
 * tiles together form a rectangle.
 */
import type { TileMap } from "./map.ts";

/** A tile position. */
export interface Tile {
  readonly tx: number;
  readonly ty: number;
}

/** The neighbour order. Fixed, so ties always go the same way. */
const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * The first tile to step to on a shortest path from `from` to `to`, avoiding tiles for which
 * `blocked(tx, ty)` is true. Returns `from` itself when already there, and undefined when `to`
 * can't be reached (or is blocked).
 */
export function nextStep(
  map: TileMap,
  blocked: (tx: number, ty: number) => boolean,
  from: Tile,
  to: Tile,
): Tile | undefined {
  if (from.tx === to.tx && from.ty === to.ty) return from;
  const w = map.width;
  const inside = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < w && ty < map.height;
  if (!inside(to.tx, to.ty) || blocked(to.tx, to.ty)) return undefined;
  // came[i] = the tile index this tile was first reached from (−1 = not reached yet).
  const came = new Int32Array(w * map.height).fill(-1);
  const start = from.ty * w + from.tx;
  const goal = to.ty * w + to.tx;
  came[start] = start;
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    if (i === goal) break;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inside(nx, ny)) continue;
      const n = ny * w + nx;
      if (came[n] !== -1 || blocked(nx, ny)) continue;
      came[n] = i;
      queue.push(n);
    }
  }
  if (came[goal] === -1) return undefined; // never reached
  // Walk back from the goal until the tile whose "came from" is the start: that's the first step.
  let i = goal;
  while (came[i] !== start) i = came[i]!;
  return { tx: i % w, ty: Math.floor(i / w) };
}
