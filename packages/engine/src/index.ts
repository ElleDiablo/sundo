/**
 * The engine's public API: everything other packages (client, server, simulator) may import from
 * "@sundo/engine". Files not listed here are internal.
 *
 * The engine is pure and deterministic (ADR-0004): no clock, no network, no DOM, no Math.random.
 * The same inputs always give the same game, in the browser, in tests and in the simulator.
 */

// Light and sight (S3-01): safe zones, the flashlight cone, line of sight past walls.
export {
  inCone,
  inZone,
  LIGHT_COS2,
  LIGHT_RANGE,
  lineOfSight,
  tileInZone,
  type Zone,
} from "./light.ts";
// Path-finding on the tile grid (S3-02).
export { nextStep, type Tile } from "./path.ts";
// The tikbalang's state machine (S3-02).
export {
  AMBUSH_RANGE,
  CATCH_RANGE,
  canSee,
  GRACE_TICKS,
  isLit,
  LOSE_SIGHT_TICKS,
  SIGHT_DARK,
  SIGHT_LIT,
  spawnTikbalang,
  STALK_GAP,
  TIK_SPEED,
  updateTikbalang,
  type TikbalangState,
  type TikMode,
  type TikWorld,
} from "./tikbalang.ts";
// Seeded random numbers (the only randomness the engine may use).
export { createRng, type Rng } from "./rng.ts";
// The tile map: which tiles are walls, and unit/tile conversions.
export { isWall, mapFromRows, tileOf, UNITS_PER_TILE, type TileMap } from "./map.ts";
// Reading maps saved by the Tiled editor.
export {
  findTiledPoint,
  findTiledPoints,
  findTiledRects,
  mapFromTiled,
  TILE_SIZE_PX,
  type TiledLayer,
  type TiledMap,
  type TiledObject,
  type TiledTileset,
} from "./tiled.ts";
// Game state and the rules: createGame, addPlayer, startRound, kidHome, the tick function step(),
// and the end of a round (S2-05): teamScore, secondsLeft, returnToLobby.
export {
  addPlayer,
  BATTERY_MAX,
  BATTERY_RECHARGE,
  CALL_RANGE,
  createGame,
  EMOTE_COOLDOWN_TICKS,
  EMOTE_COUNT,
  EMOTE_TICKS,
  ESCORT_DIAGONAL_SPEED,
  ESCORT_SPEED,
  FOLLOW_GAP,
  FULL_ROOM,
  HAT_COUNT,
  HOME_RANGE,
  KID_COUNT,
  kidHome,
  KID_SPEED,
  MAX_ESCORT,
  PLAYER_DIAGONAL_SPEED,
  PLAYER_HALF_SIZE,
  PLAYER_SPEED,
  removePlayer,
  returnToLobby,
  ROUND_TICKS,
  SCORE_PER_KID,
  SCORE_PER_SECOND,
  SCORE_PER_TIME_LOST,
  secondsLeft,
  SHIRT_COUNT,
  START_COUNTDOWN_TICKS,
  startRound,
  step,
  teamScore,
  type GameEvent,
  type GameOptions,
  type GameState,
  type Inputs,
  type KidState,
  type MoveInput,
  type Phase,
  type PlayerInput,
  type PlayerSpawn,
  type PlayerState,
  type Spot,
  type StepResult,
} from "./game.ts";

/** Fixed simulation step: 20 ticks per second (ADR-0004). */
export const TICK_MS = 50;
export const TICKS_PER_SECOND = 1000 / TICK_MS;
