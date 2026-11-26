/**
 * How the tikbalang's approach is heard and shown (S3-05, GDD §9: "hooves get louder as the
 * tikbalang gets closer, which is the main horror tool").
 *
 * `warning()` turns the distance to the tikbalang (and its mode) into three numbers: how often a
 * hoofbeat plays, how loud, and how strong the on-screen ring is. It's a pure function (no sound,
 * no drawing), so it can be tested; WorldScene plays and draws what it returns.
 *
 *   distance   12 tiles ─────────────── 1 tile
 *   interval    900 ms  ─────────────── 350 ms   (250 ms during a chase: galloping)
 *   volume      0       ─────────────── 0.25     (curved: quiet for most of the way, then loud)
 *   ring        0       ─────────────── 1
 */
import type { SnapshotTikbalang } from "@sundo/server/messages";

/** Beyond this distance (12 tiles), silence and no ring. */
export const HEARING_TILES = 12;

export interface Warning {
  readonly intervalMs: number; // time between hoofbeats
  readonly volume: number; // 0–0.25
  readonly ring: number; // 0–1: how strong the edge ring is
}

/** What to play and show for a tikbalang `tiles` away in `mode`; undefined = nothing. */
export function warning(tiles: number, mode: SnapshotTikbalang["mode"]): Warning | undefined {
  // Waiting (the grace period, a rest) or lying in ambush: silent. An ambush you can hear coming
  // isn't an ambush.
  if (mode === "wait" || mode === "ambush") return undefined;
  if (tiles > HEARING_TILES) return undefined;
  const near = 1 - Math.max(0, tiles - 1) / (HEARING_TILES - 1); // 0 at 12 tiles, 1 at ≤ 1 tile
  return {
    intervalMs: mode === "chase" ? 250 : Math.round(900 - 550 * near),
    volume: 0.25 * near ** 1.5,
    ring: near,
  };
}
