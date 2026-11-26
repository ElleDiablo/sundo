/**
 * The five lost children (S2-02), as the game shows them. The engine only knows them as "k0"…"k4"
 * and positions; this file gives each one a name and a row in sprites/kids.png. The sprites come
 * from my modern character sheet (scripts/sprites/kids.json, in this same order) and get the same
 * generated 4-frame walk as the tanod.
 */

/** Names in the same order as the spritesheet rows and the engine's ids (k0 = Tala, …). */
export const KID_NAMES = ["Tala", "Jun", "Migs", "Ana", "Nico"] as const;

/** Which spritesheet row draws this child: "k3" → 3. Unknown ids fall back to row 0. */
export function kidRow(id: string): number {
  const row = Number(id.slice(1));
  return Number.isInteger(row) && row >= 0 && row < KID_NAMES.length ? row : 0;
}
