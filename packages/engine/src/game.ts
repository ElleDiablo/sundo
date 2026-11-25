/**
 * Game state and the step() function (ADR-0004).
 *
 * step(state, inputs) → { state, events } is a pure function: it never changes the state it is
 * given, never reads the clock, the DOM or the network. The host browser calls it 20 times a
 * second; tests and the simulator call it as fast as they like and get identical results.
 */
import { isWall, tileOf, UNITS_PER_TILE, type TileMap } from "./map.ts";

/** Player speed: 4 tiles/s at 20 ticks/s = 0.2 tiles = 200 units per tick. */
export const PLAYER_SPEED = 200;

/**
 * Per-axis speed when moving diagonally: 200 / √2 ≈ 141.4, rounded down to stay whole.
 * Without this, holding W+D would move 200 right AND 200 up, about 283 per tick: 41% faster.
 */
export const PLAYER_DIAGONAL_SPEED = Math.floor(PLAYER_SPEED / Math.SQRT2);

/**
 * Half the width of a player's collision box (0.3 tiles). The box is 0.6 × 0.6 tiles, a bit
 * smaller than a tile so players fit through 1-tile gaps without pixel-perfect aiming.
 */
export const PLAYER_HALF_SIZE = 300;

/** Which movement keys a player is holding during this tick. */
export interface MoveInput {
  readonly up: boolean;
  readonly down: boolean;
  readonly left: boolean;
  readonly right: boolean;
}

export interface PlayerState {
  readonly id: string;
  /** Centre of the player's box, in units (1 tile = 1000). */
  readonly x: number;
  readonly y: number;
}

export interface GameState {
  /** How many steps have run. Snapshots (S1-05) are labelled with it. */
  readonly tick: number;
  readonly map: TileMap;
  /** An array, not an object, so players are always processed in the same order. */
  readonly players: readonly PlayerState[];
}

/** Inputs for one tick, by player id. A missing player is treated as "no keys held". */
export type Inputs = Readonly<Record<string, MoveInput>>;

/** Things that happened during a step (sounds, catches, rescues). None exist yet. */
export type GameEvent = never;

export interface StepResult {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

export interface PlayerSpawn {
  readonly id: string;
  /** The tile the player starts in; they are placed at its centre. */
  readonly tileX: number;
  readonly tileY: number;
}

export function createGame(map: TileMap, spawns: readonly PlayerSpawn[]): GameState {
  const players = spawns.map(({ id, tileX, tileY }) => {
    if (isWall(map, tileX, tileY)) {
      throw new RangeError(`player ${id} would spawn inside a wall at (${tileX}, ${tileY})`);
    }
    return { id, x: tileX * UNITS_PER_TILE + 500, y: tileY * UNITS_PER_TILE + 500 };
  });
  return { tick: 0, map, players };
}

export function step(state: GameState, inputs: Inputs): StepResult {
  const players = state.players.map((player) => {
    const input = inputs[player.id];
    return input ? movePlayer(state.map, player, input) : player;
  });
  return { state: { tick: state.tick + 1, map: state.map, players }, events: [] };
}

/** Turns held keys into a movement for one tick, then applies it with wall collision. */
function movePlayer(map: TileMap, player: PlayerState, input: MoveInput): PlayerState {
  // Opposite keys cancel out: holding A and D together means standing still on that axis.
  const dirX = Number(input.right) - Number(input.left);
  const dirY = Number(input.down) - Number(input.up);
  if (dirX === 0 && dirY === 0) return player;

  const speed = dirX !== 0 && dirY !== 0 ? PLAYER_DIAGONAL_SPEED : PLAYER_SPEED;

  // Move one axis at a time. If the diagonal is blocked on x, the y move still happens,
  // so the player slides along the wall instead of sticking to it.
  const x = moveX(map, player.x, player.y, dirX * speed);
  const y = moveY(map, x, player.y, dirY * speed);
  return { ...player, x, y };
}

/**
 * The tiles a box covers, from its first unit to its last.
 * A box centred at 1500 with half-size 300 covers units 1200…1799, so only tile 1.
 */
function tileSpan(centre: number): { first: number; last: number } {
  return {
    first: tileOf(centre - PLAYER_HALF_SIZE),
    last: tileOf(centre + PLAYER_HALF_SIZE - 1),
  };
}

function moveX(map: TileMap, x: number, y: number, dx: number): number {
  if (dx === 0) return x;
  const nextX = x + dx;
  const rows = tileSpan(y);
  const cols = tileSpan(nextX);
  // Only the leading edge can enter a new column (speed < 1 tile per tick, so no skipping).
  const col = dx > 0 ? cols.last : cols.first;
  for (let ty = rows.first; ty <= rows.last; ty++) {
    if (isWall(map, col, ty)) {
      // Stop flush against the wall: right edge at its left side, or left edge at its right side.
      return dx > 0
        ? col * UNITS_PER_TILE - PLAYER_HALF_SIZE
        : (col + 1) * UNITS_PER_TILE + PLAYER_HALF_SIZE;
    }
  }
  return nextX;
}

function moveY(map: TileMap, x: number, y: number, dy: number): number {
  if (dy === 0) return y;
  const nextY = y + dy;
  const cols = tileSpan(x);
  const rows = tileSpan(nextY);
  const row = dy > 0 ? rows.last : rows.first;
  for (let tx = cols.first; tx <= cols.last; tx++) {
    if (isWall(map, tx, row)) {
      return dy > 0
        ? row * UNITS_PER_TILE - PLAYER_HALF_SIZE
        : (row + 1) * UNITS_PER_TILE + PLAYER_HALF_SIZE;
    }
  }
  return nextY;
}
