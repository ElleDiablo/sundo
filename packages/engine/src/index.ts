export { createRng, type Rng } from "./rng.ts";
export { isWall, mapFromRows, tileOf, UNITS_PER_TILE, type TileMap } from "./map.ts";
export {
  createGame,
  PLAYER_DIAGONAL_SPEED,
  PLAYER_HALF_SIZE,
  PLAYER_SPEED,
  step,
  type GameEvent,
  type GameState,
  type Inputs,
  type MoveInput,
  type PlayerSpawn,
  type PlayerState,
  type StepResult,
} from "./game.ts";

/** Fixed simulation step: 20 ticks per second (ADR-0004). */
export const TICK_MS = 50;
export const TICKS_PER_SECOND = 1000 / TICK_MS;
