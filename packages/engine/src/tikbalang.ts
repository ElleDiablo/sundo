/**
 * The tikbalang (S3-02, GDD §5): the monster, run by the host's engine like everything else.
 *
 * It's a state machine: at any moment it's in exactly one MODE, and each mode has its own
 * behaviour and its own rules for switching to another mode:
 *
 *   wait ──(timer ends)──► patrol ──(sees a player)──► stalk ──(target alone / slow 2 s,
 *    ▲                       │  ▲                        │        or stalked 10 s)──► chase
 *    │                       │  └──(lost sight 3 s)──────┴──────────────────────────────┘
 *    │      (reached a patrol point, 1 in 3)                                            │
 *    │                       ▼                                                          │
 *    │                    ambush ──(player within 4 tiles)──► chase                     │
 *    └──────────────────────────────────(caught someone: rests)─────────────────────────┘
 *
 *   wait    stands still: the 10 s grace at the start of a round, and a rest after a catch
 *   patrol  walks from patrol point to patrol point (the map's "patrol" points)
 *   ambush  walks to an ambush point (the map's "ambush" points: the bridge, a dike junction…)
 *           and waits there 15 s, charging anyone who comes within 4 tiles
 *   stalk   follows a player it can see, staying about 4 tiles away
 *   chase   runs straight at them (path-finding around walls); within 0.7 tiles = caught
 *
 * It can never see a player in baliktad (S3-04: shirt inside out); if that's who it was stalking or
 * chasing, it loses them at once and goes back to patrolling.
 *
 * What it can see: a player within 5 tiles (9 if their flashlight is on: the light gives them
 * away), with no wall in between, and NOT inside a safe zone. It never walks into a safe zone
 * either (path-finding treats safe tiles as walls). A flashlight shone at it (inside someone's
 * cone, with nothing in the way) halves its speed.
 *
 * Every random choice uses the game's seeded generator, so a replay has the same tikbalang.
 * Later sprints swap the fixed ambush points for ones learned from past rounds (GDD §6).
 */
import { inCone, inZone, lineOfSight, tileInZone, type Zone } from "./light.ts";
import { isWall, tileOf, UNITS_PER_TILE, type TileMap } from "./map.ts";
import { nextStep } from "./path.ts";
import type { Rng } from "./rng.ts";
// Types only (erased when the code runs), so game.ts and this file can refer to each other.
import type { GameEvent, KidState, PlayerState, Spot } from "./game.ts";

// ─── Tuning ──────────────────────────────────────────────────────────────────────────────────
/** Normal speed: 3 tiles/s = 150 units a tick (between an escort's 2.5 and a free player's 4). */
export const TIK_SPEED = 150;
/** How far it sees a player in the dark (5 tiles), and one whose flashlight is on (9 tiles). */
export const SIGHT_DARK = 5000;
export const SIGHT_LIT = 9000;
/** Stalking keeps about this far away (4 tiles). */
export const STALK_GAP = 4000;
/** "Alone": no other player within 3 tiles of the target. */
export const ALONE_RANGE = 3000;
/** Alone or escorting for this long (2 s) while stalked → chase. Or stalked this long (10 s). */
export const PRESSURE_TICKS = 40;
export const STALK_MAX_TICKS = 200;
/** Out of sight this long (3 s) → gives up and patrols. */
export const LOSE_SIGHT_TICKS = 60;
/** At an ambush point: charges anyone visible within 4 tiles; waits 15 s, then patrols on. */
export const AMBUSH_RANGE = 4000;
export const AMBUSH_TICKS = 300;
/** Reaching a target this close (0.7 tiles, centre to centre) is a catch. */
export const CATCH_RANGE = 700;
/** The grace period at the start of a round (10 s), and the rest after a catch (5 s). */
export const GRACE_TICKS = 200;
export const REST_TICKS = 100;
/** "Arrived" at a patrol or ambush point: within this distance of its centre. */
const ARRIVED = 200;

export type TikMode = "wait" | "patrol" | "ambush" | "stalk" | "chase";

export interface TikbalangState {
  readonly x: number; // centre, in units, like a player
  readonly y: number;
  readonly mode: TikMode;
  readonly target: string | null; // the player it's stalking or chasing
  readonly goal: number; // index of the patrol point (patrol) or ambush point (ambush) it heads to
  readonly timer: number; // ticks left (wait, ambush) or ticks spent so far (stalk)
  readonly unseen: number; // ticks since it last saw its target
  readonly pressure: number; // ticks the target has been alone or escorting while stalked
  readonly faceX: number; // −1 or 1: which way it last moved left/right (the sprite flips)
}

/** The fixed parts of the world the tikbalang needs (from the map, via GameState). */
export interface TikWorld {
  readonly map: TileMap;
  readonly safeZones: readonly Zone[];
  readonly patrol: readonly Spot[];
  readonly ambush: readonly Spot[];
}

/** What happened during the tikbalang's tick. */
export interface TikResult {
  readonly tikbalang: TikbalangState;
  /** The id of the player it caught this tick, if any (S3-03 sends them to the bamboo grove). */
  readonly caught: string | null;
}

/** A new tikbalang at the map's spawn point, waiting out the round's 10 s grace period. */
export function spawnTikbalang(spot: Spot): TikbalangState {
  return {
    ...centre(spot),
    mode: "wait",
    target: null,
    goal: 0,
    timer: GRACE_TICKS,
    unseen: 0,
    pressure: 0,
    faceX: 1,
  };
}

/** Can the tikbalang see this player? (In range for their light, outside safe zones, no wall between.) */
export function canSee(t: TikbalangState, p: PlayerState, world: TikWorld): boolean {
  if (p.baliktad > 0) return false; // S3-04: shirt inside out
  if (inZone(world.safeZones, p.x, p.y)) return false;
  const range = p.light ? SIGHT_LIT : SIGHT_DARK;
  if (dist2(t, p) > range * range) return false;
  return lineOfSight(world.map, t.x, t.y, p.x, p.y);
}

/** Is any player's flashlight shining on the tikbalang (inside their cone, nothing in between)? */
export function isLit(t: TikbalangState, players: readonly PlayerState[], map: TileMap): boolean {
  return players.some(
    (p) =>
      p.light &&
      inCone(p.x, p.y, p.faceX, p.faceY, t.x, t.y) &&
      lineOfSight(map, p.x, p.y, t.x, t.y),
  );
}

/**
 * Runs the tikbalang for one tick: decide (maybe switch mode), then move. `kids` tells it who is
 * escorting (escorting players are slow: easy prey). Random choices use `rng`.
 */
export function updateTikbalang(
  t: TikbalangState,
  players: readonly PlayerState[],
  kids: readonly KidState[],
  world: TikWorld,
  rng: Rng,
  events: GameEvent[],
): TikResult {
  const target = t.target ? players.find((p) => p.id === t.target) : undefined;
  const speed = isLit(t, players, world.map) ? Math.floor(TIK_SPEED / 2) : TIK_SPEED;

  switch (t.mode) {
    case "wait": {
      if (t.timer > 1) return still({ ...t, timer: t.timer - 1 });
      return still(toPatrol(t, rng, world));
    }

    case "patrol": {
      const seen = nearestSeen(t, players, world);
      if (seen) return still(toStalk(t, seen, events));
      const point = world.patrol[t.goal];
      if (!point) return still(t); // a map without patrol points: stand guard
      if (arrived(t, point)) {
        // At a patrol point: 1 in 3 times go and lie in wait at an ambush point instead.
        if (world.ambush.length > 0 && rng.int(0, 2) === 0) {
          const goal = rng.int(0, world.ambush.length - 1);
          return still({ ...t, mode: "ambush", goal, timer: AMBUSH_TICKS });
        }
        return still(toPatrol(t, rng, world));
      }
      return still(walk(t, centre(point), speed, world));
    }

    case "ambush": {
      const point = world.ambush[t.goal];
      if (!point) return still(toPatrol(t, rng, world));
      if (!arrived(t, point)) {
        // On the way: it notices players like on patrol.
        const seen = nearestSeen(t, players, world);
        if (seen) return still(toStalk(t, seen, events));
        return still(walk(t, centre(point), speed, world));
      }
      // Lying in wait: charge anyone visible within AMBUSH_RANGE; otherwise keep still.
      const near = nearestSeen(t, players, world, AMBUSH_RANGE);
      if (near) return still(toChase(t, near, events));
      if (t.timer <= 1) return still(toPatrol(t, rng, world));
      return still({ ...t, timer: t.timer - 1 });
    }

    case "stalk": {
      // They left the room, or turned their shirt inside out (S3-04): gone.
      if (!target || target.baliktad > 0) return still(toPatrol(t, rng, world));
      const sees = canSee(t, target, world);
      const unseen = sees ? 0 : t.unseen + 1;
      if (unseen >= LOSE_SIGHT_TICKS) return still(toPatrol(t, rng, world));
      // Prey that's alone or slowed by a child builds up "pressure" until it pounces.
      const escorting = kids.some((k) => k.following === target.id);
      const alone = !players.some(
        (p) => p.id !== target.id && dist2(p, target) <= ALONE_RANGE * ALONE_RANGE,
      );
      const pressure = sees && (alone || escorting) ? t.pressure + 1 : 0;
      if (pressure >= PRESSURE_TICKS || t.timer + 1 >= STALK_MAX_TICKS) {
        return still(toChase(t, target, events));
      }
      const next = { ...t, unseen, pressure, timer: t.timer + 1 };
      // Keep about STALK_GAP away: close in when further, stand and watch when nearer.
      if (dist2(t, target) > STALK_GAP * STALK_GAP) {
        return still(walk(next, target, speed, world));
      }
      return still(next);
    }

    case "chase": {
      if (!target || target.baliktad > 0) return still(toPatrol(t, rng, world));
      const unseen = canSee(t, target, world) ? 0 : t.unseen + 1;
      if (unseen >= LOSE_SIGHT_TICKS) return still(toPatrol(t, rng, world));
      const moved = walk({ ...t, unseen }, target, speed, world);
      if (dist2(moved, target) <= CATCH_RANGE * CATCH_RANGE) {
        events.push({ type: "caught", player: target.id });
        const rest = { ...moved, mode: "wait", target: null, timer: REST_TICKS } as const;
        return { tikbalang: rest, caught: target.id };
      }
      return still(moved);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────

/** A result with nobody caught. */
const still = (tikbalang: TikbalangState): TikResult => ({ tikbalang, caught: null });

/** The centre of a tile, in units. */
function centre(spot: Spot): { x: number; y: number } {
  return { x: spot.tileX * UNITS_PER_TILE + 500, y: spot.tileY * UNITS_PER_TILE + 500 };
}

/** Squared distance between two points (whole numbers, no square root). */
function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function arrived(t: TikbalangState, spot: Spot): boolean {
  return dist2(t, centre(spot)) <= ARRIVED * ARRIVED;
}

/** The nearest player it can see (within `range` too, if given). Ties go to the earlier player. */
function nearestSeen(
  t: TikbalangState,
  players: readonly PlayerState[],
  world: TikWorld,
  range = Infinity,
): PlayerState | undefined {
  let best: PlayerState | undefined;
  let bestD = range * range;
  for (const p of players) {
    const d = dist2(t, p);
    if (d <= bestD && canSee(t, p, world) && (!best || d < bestD)) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** Back to patrolling, heading for a random patrol point. */
function toPatrol(t: TikbalangState, rng: Rng, world: TikWorld): TikbalangState {
  const goal = world.patrol.length > 0 ? rng.int(0, world.patrol.length - 1) : 0;
  return { ...t, mode: "patrol", target: null, goal, timer: 0, unseen: 0, pressure: 0 };
}

function toStalk(t: TikbalangState, p: PlayerState, events: GameEvent[]): TikbalangState {
  events.push({ type: "tikbalang", mode: "stalk", player: p.id });
  return { ...t, mode: "stalk", target: p.id, timer: 0, unseen: 0, pressure: 0 };
}

function toChase(t: TikbalangState, p: PlayerState, events: GameEvent[]): TikbalangState {
  events.push({ type: "tikbalang", mode: "chase", player: p.id });
  return { ...t, mode: "chase", target: p.id, timer: 0, unseen: 0, pressure: 0 };
}

/**
 * Moves up to `speed` units toward (gx, gy): through the centre of the next tile on a shortest
 * path, avoiding walls and safe zones. In the goal's own tile it heads straight for the point.
 * If there's no way there (the goal is inside a safe zone), it stays where it is.
 */
function walk(
  t: TikbalangState,
  goal: { x: number; y: number },
  speed: number,
  world: TikWorld,
): TikbalangState {
  const blocked = (tx: number, ty: number) =>
    isWall(world.map, tx, ty) || tileInZone(world.safeZones, tx, ty);
  const from = { tx: tileOf(t.x), ty: tileOf(t.y) };
  const to = { tx: tileOf(goal.x), ty: tileOf(goal.y) };
  const step = nextStep(world.map, blocked, from, to);
  if (!step) return t;
  const aim =
    step.tx === from.tx && step.ty === from.ty
      ? goal
      : { x: step.tx * UNITS_PER_TILE + 500, y: step.ty * UNITS_PER_TILE + 500 };
  const dx = aim.x - t.x;
  const dy = aim.y - t.y;
  // Math.sqrt is exactly rounded in every JavaScript engine (see game.ts moveKids).
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0) return t;
  const go = Math.min(speed, d);
  const x = t.x + Math.round((dx * go) / d);
  const y = t.y + Math.round((dy * go) / d);
  return { ...t, x, y, faceX: dx > 0 ? 1 : dx < 0 ? -1 : t.faceX };
}
