/**
 * Where a flashlight points (look pass): one of AIM_STEPS directions around a circle, stored as a
 * whole number 0 … 31. 0 points right, and the numbers go clockwise on screen (y grows downwards),
 * so 8 = down, 16 = left, 24 = up. 32 steps = 11.25° each, much finer than the cone (35° each side),
 * so the light follows the mouse smoothly enough; the client draws my own beam at the exact mouse
 * angle anyway, and only the engine's "is the tikbalang lit" test uses the steps.
 *
 * Why a number and not an angle: the host and every guest's prediction must agree exactly
 * (ADR-0004), and Math.cos / Math.sin may differ in the last bit between browsers. A whole number
 * that indexes a table of whole-number vectors gives every machine the same answer.
 */

/** How many directions a flashlight can point in. */
export const AIM_STEPS = 32;

/**
 * AIM_VECTORS[aim] = [x, y]: the direction as a vector 1000 units long (cos and sin × 1000,
 * rounded). Written out as numbers (generated once with Math.cos / Math.sin) rather than computed,
 * for the reason above.
 */
export const AIM_VECTORS: readonly (readonly [number, number])[] = [
  [1000, 0], [981, 195], [924, 383], [831, 556], [707, 707], [556, 831], [383, 924], [195, 981],
  [0, 1000], [-195, 981], [-383, 924], [-556, 831], [-707, 707], [-831, 556], [-924, 383], [-981, 195],
  [-1000, 0], [-981, -195], [-924, -383], [-831, -556], [-707, -707], [-556, -831], [-383, -924], [-195, -981],
  [0, -1000], [195, -981], [383, -924], [556, -831], [707, -707], [831, -556], [924, -383], [981, -195],
]; // prettier-ignore

/** Is this a valid aim (a whole number 0 … AIM_STEPS − 1)? Inputs and snapshots are checked with it. */
export function isAim(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < AIM_STEPS;
}

/**
 * The aim for walking keys: dirX, dirY each −1, 0 or 1, not both 0. The 8 key directions land on
 * every 4th step (45° apart). Used when a player steers the light with the keys, not the mouse.
 */
export function aimOfKeys(dirX: number, dirY: number): number {
  // Index 0 … 8 of (dirX + 1) * 3 + (dirY + 1); 4 is (0, 0), which never happens.
  const BY_KEYS = [20, 16, 12, 24, 0, 8, 28, 0, 4];
  return BY_KEYS[(dirX + 1) * 3 + (dirY + 1)] ?? 8;
}

/**
 * The nearest aim to an angle in radians (0 = right, clockwise on screen). Only the client uses it,
 * to turn the mouse position into an input; the engine never calls trigonometry.
 */
export function aimOfAngle(radians: number): number {
  const step = Math.round((radians / (2 * Math.PI)) * AIM_STEPS);
  return ((step % AIM_STEPS) + AIM_STEPS) % AIM_STEPS; // wrap negatives: −1 → 31
}

/** An aim back to an angle in radians, for drawing. */
export function angleOfAim(aim: number): number {
  return (aim / AIM_STEPS) * 2 * Math.PI;
}
