/**
 * Light and sight (S3-01, used by the tikbalang in S3-02): safe zones, the flashlight cone, and
 * whether one point can see another past the walls.
 *
 * Everything is whole-number or exactly-rounded arithmetic (no Math.hypot, no trigonometry at run
 * time), so the host and every guest's prediction get identical answers (ADR-0004).
 */
import { AIM_VECTORS } from "./aim.ts";
import { isWall, tileOf, UNITS_PER_TILE, type TileMap } from "./map.ts";

/** A rectangle of whole tiles: the safe zones (the kapilya plaza, the sari-sari store). */
export interface Zone {
  readonly tileX: number; // left column
  readonly tileY: number; // top row
  readonly width: number; // in tiles
  readonly height: number; // in tiles
}

/** How far a flashlight reaches: 5 tiles. */
export const LIGHT_RANGE = 5000;
/**
 * Half the cone's width: 35°, stored as its cosine squared (cos 35° ≈ 0.819, squared ≈ 0.671), so
 * the cone test needs no square roots or angles (see inCone). Written as a literal rather than
 * computed with Math.cos, whose last bit can differ between JavaScript engines.
 */
export const LIGHT_COS2 = 0.671;

/** Is the point (x, y), in units, inside any of these zones? */
export function inZone(zones: readonly Zone[], x: number, y: number): boolean {
  const tx = tileOf(x);
  const ty = tileOf(y);
  return zones.some(
    (z) => tx >= z.tileX && tx < z.tileX + z.width && ty >= z.tileY && ty < z.tileY + z.height,
  );
}

/** Is this tile inside any of these zones? (For path-finding: the tikbalang avoids them.) */
export function tileInZone(zones: readonly Zone[], tx: number, ty: number): boolean {
  return inZone(zones, tx * UNITS_PER_TILE, ty * UNITS_PER_TILE);
}

/**
 * Can a straight line from (x1, y1) to (x2, y2) pass without crossing a wall tile? Checks points
 * every quarter tile along the line (a wall is a whole tile, so it can't slip between two checks).
 * Integer division by `steps` and Math.round are exact, so every machine agrees.
 */
export function lineOfSight(map: TileMap, x1: number, y1: number, x2: number, y2: number): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 250));
  for (let i = 1; i < steps; i++) {
    const x = x1 + Math.round((dx * i) / steps);
    const y = y1 + Math.round((dy * i) / steps);
    if (isWall(map, tileOf(x), tileOf(y))) return false;
  }
  return true;
}

/**
 * Is (x, y) inside the cone of a flashlight at (fromX, fromY) pointing at `aim` (aim.ts)?
 * Within LIGHT_RANGE, and within 35° of the pointing direction. The angle test without angles:
 * for the vector v to the point and the direction f, the angle is under 35° when
 * v·f > 0 and (v·f)² ≥ cos²35° × |v|² × |f|². Walls are checked separately (lineOfSight).
 */
export function inCone(fromX: number, fromY: number, aim: number, x: number, y: number): boolean {
  const [faceX, faceY] = AIM_VECTORS[aim] ?? [0, 1000]; // an unknown aim points down
  const vx = x - fromX;
  const vy = y - fromY;
  const dist2 = vx * vx + vy * vy;
  if (dist2 > LIGHT_RANGE * LIGHT_RANGE) return false;
  if (dist2 === 0) return true;
  const dot = vx * faceX + vy * faceY;
  if (dot <= 0) return false;
  const face2 = faceX * faceX + faceY * faceY; // about 1000² (the table's vectors are 1000 long)
  return dot * dot >= LIGHT_COS2 * dist2 * face2;
}
