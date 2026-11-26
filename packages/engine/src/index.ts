/**
 * The engine's public API: everything other packages (client, server, simulator) may import from
 * "@sundo/engine". Files not listed here are internal.
 *
 * The engine is pure and deterministic (ADR-0004): no clock, no network, no DOM, no Math.random.
 * The same inputs always give the same game, in the browser, in tests and in the simulator.
 */

// Seeded random numbers (the only randomness the engine may use).
export { createRng, type Rng } from "./rng.ts";
// The tile map: which tiles are walls, and unit/tile conversions.
export { isWall, mapFromRows, tileOf, UNITS_PER_TILE, type TileMap } from "./map.ts";
// Reading maps saved by the Tiled editor.
export {
  findTiledPoint,
  mapFromTiled,
  TILE_SIZE_PX,
  type TiledLayer,
  type TiledMap,
  type TiledObject,
  type TiledTileset,
} from "./tiled.ts";
// Game state and the rules: createGame, addPlayer, startRound and the tick function step().
export {
  addPlayer,
  createGame,
  FULL_ROOM,
  HAT_COUNT,
  PLAYER_DIAGONAL_SPEED,
  PLAYER_HALF_SIZE,
  PLAYER_SPEED,
  removePlayer,
  SHIRT_COUNT,
  START_COUNTDOWN_TICKS,
  startRound,
  step,
  type GameEvent,
  type GameState,
  type Inputs,
  type MoveInput,
  type Phase,
  type PlayerInput,
  type PlayerSpawn,
  type PlayerState,
  type StepResult,
} from "./game.ts";

/** Fixed simulation step: 20 ticks per second (ADR-0004). */
export const TICK_MS = 50;
export const TICKS_PER_SECOND = 1000 / TICK_MS;
