/**
 * The hats and shirt colours a player can pick in the lobby plaza (S2-01), in one place for both
 * the asset generator (scripts/make-assets.ts draws one spritesheet row per look) and the game
 * (the picker's labels, and which row of the sheet to draw).
 *
 * The engine only knows looks as numbers (`hat` 0–3, `shirt` 0–5) and checks the range with
 * HAT_COUNT / SHIRT_COUNT; looks.test.ts makes sure these lists have the same lengths.
 *
 * No imports on purpose: make-assets.ts runs directly in Node, and this file has to load there too.
 *
 * Spritesheet layout (sprites/tanod.png): 4 walk frames across, one row per look:
 *
 *   row = hat × SHIRTS.length + shirt          frame = row × 4 + walk frame (0–3)
 *
 *   row 0  salakot + gold   ▢▢▢▢
 *   row 1  salakot + blue   ▢▢▢▢
 *   …
 *   row 23 no hat + charcoal▢▢▢▢
 */

/** Hats, by number. 0 is the salakot from my character sheet; the rest are generated placeholders. */
export const HATS = ["Salakot", "Cap", "Bandana", "No hat"] as const;

/**
 * Shirt colours, by number. 0 keeps the gold of my character sheet; the others recolour the shirt
 * pixels, keeping their light and shade. Seats start on different colours (defaultShirt).
 */
export const SHIRTS = [
  { name: "Gold", hex: "#d1a351" },
  { name: "Blue", hex: "#4f78c4" },
  { name: "Red", hex: "#c4473f" },
  { name: "Green", hex: "#4f9a56" },
  { name: "White", hex: "#e6e1d6" },
  { name: "Charcoal", hex: "#4a4d57" },
] as const;

/** Walk frames per look (stand, left step, dip, right step). */
export const WALK_FRAMES = 4;

/** Which spritesheet row draws this look. */
export function lookRow(hat: number, shirt: number): number {
  return hat * SHIRTS.length + shirt;
}

/** The shirt each seat starts in: everyone looks different before anyone picks (seat 0 = gold). */
export function defaultShirt(seat: number): number {
  return seat % SHIRTS.length;
}
