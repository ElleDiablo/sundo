/**
 * The tile map: which squares are walls and which are walkable.
 *
 * Positions inside the engine are whole numbers of "units" (fixed-point), not fractional tiles.
 * 1 tile = 1000 units. Integer maths is exact, so collision checks never suffer from float
 * rounding (e.g. 0.1 + 0.2 !== 0.3), and every machine computes the same result (ADR-0004).
 */
export const UNITS_PER_TILE = 1000;

export interface TileMap {
  /** Width in tiles. */
  readonly width: number;
  /** Height in tiles. */
  readonly height: number;
  /** One entry per tile, row by row: index = ty * width + tx. true = wall. */
  readonly walls: readonly boolean[];
}

/**
 * Builds a map from text rows: `#` = wall, `.` = floor. Handy for tests and placeholder maps;
 * the real map (S1-01) comes from Tiled and is converted into the same TileMap shape.
 */
export function mapFromRows(rows: readonly string[]): TileMap {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (height === 0 || width === 0) throw new RangeError("map needs at least one tile");

  const walls: boolean[] = [];
  rows.forEach((row, ty) => {
    if (row.length !== width) {
      throw new RangeError(`row ${ty} has ${row.length} tiles, expected ${width}`);
    }
    for (const ch of row) {
      if (ch !== "#" && ch !== ".") throw new RangeError(`unknown tile "${ch}" in row ${ty}`);
      walls.push(ch === "#");
    }
  });
  return { width, height, walls };
}

/** Is tile (tx, ty) a wall? Anything outside the map counts as a wall, so nobody walks off it. */
export function isWall(map: TileMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return true;
  return map.walls[ty * map.width + tx] ?? true;
}

/** The tile that contains a position given in units. */
export function tileOf(units: number): number {
  return Math.floor(units / UNITS_PER_TILE);
}
