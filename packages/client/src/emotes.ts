/**
 * The four emotes (S2-06, ADR-0005): the only way to talk in Sundo. No free-text chat means nothing
 * to moderate, and short Filipino calls fit the setting. The engine only knows them as 0–3; this
 * file gives each one its words. Keys 1–4 pick them, in this order.
 *
 *   1 Dito!     "Over here!"   (I found a child / come this way)
 *   2 Takbo!    "Run!"         (the tikbalang is coming, S3)
 *   3 Tulong!   "Help!"
 *   4 Salamat!  "Thanks!"
 */
export const EMOTES = ["Dito!", "Takbo!", "Tulong!", "Salamat!"] as const;

/**
 * How long a quick tap of 1–4 stays in my input. A tap can be shorter than one engine tick (50 ms)
 * or fall between two of a guest's messages, and the host only sees the keys a tick or a message
 * carries, so a 1-frame tap could be missed. Keeping it for 150 ms covers 3 ticks and at least one
 * message; the engine's once-a-second limit stops it from showing twice.
 */
export const EMOTE_HOLD_MS = 150;

/** The words for an emote number, or undefined for none / an unknown number. */
export function emoteText(emote: number | null | undefined): string | undefined {
  return emote === null || emote === undefined ? undefined : EMOTES[emote];
}
