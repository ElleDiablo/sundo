/**
 * Snapshot interpolation: how a guest draws smooth movement from 20 snapshots a second.
 *
 * The host sends where everyone is every tick (50 ms; NET-02, was every 2nd tick before). Drawing
 * each snapshot as it arrives would make players jump 0.2 tiles at a time, and network jitter (one
 * snapshot 30 ms late, the next 20 ms early) would make the jumps uneven. Instead the guest draws
 * the world slightly in the PAST, one snapshot interval (50 ms) behind the newest snapshot, so
 * there are usually two snapshots on either side of the moment being drawn, and it slides each
 * player between them:
 *
 *   snapshots   ──●────●────●────●────●   (one per 50 ms, labelled by host tick)
 *                      ▲  drawn here: 30 % of the way from one to the next
 *                      └─ "render time" = now − 50 ms
 *
 * The delay is the price of smoothness. It's the standard technique (used by Valve's Source
 * engine, among others), and is why the docs say guests see the world ~50 ms in the past.
 * The trade-off (NET-02): a shorter buffer shows others sooner, but a snapshot that arrives more
 * than 50 ms late leaves nothing to slide towards, so the player is held still for a moment.
 * `heldRatio` counts how often that happens, so the trade-off is measured, not guessed.
 *
 * Timing uses the host's tick numbers, not arrival times: tick 120 is exactly 6 s into the host's
 * game (120 × 50 ms), however late it arrived. To turn "now" on my clock into a time on the host's
 * clock, the buffer keeps an estimate of the gap between them (`offset`), smoothed so one late
 * snapshot doesn't shift it much.
 */
import { TICK_MS } from "@sundo/engine";
import type { SnapshotFields, SnapshotPlayer } from "@sundo/server/messages";

/** The host sends a snapshot every tick: 20 ticks/s = 20 snapshots/s (NET-02; was 2 → 10/s). */
export const TICKS_PER_SNAPSHOT = 1;
/** Time between two snapshots: 50 ms. */
export const SNAPSHOT_INTERVAL_MS = TICKS_PER_SNAPSHOT * TICK_MS;
/**
 * How far in the past guests draw the world: one snapshot interval (50 ms). Tied to the snapshot
 * rate, so changing TICKS_PER_SNAPSHOT changes both together.
 */
export const INTERPOLATION_DELAY_MS = SNAPSHOT_INTERVAL_MS;

/** How quickly the clock-gap estimate follows new snapshots (0–1; small = steady). */
const OFFSET_SMOOTHING = 0.1;
/** If the gap jumps by more than this (host tab was paused, Wi-Fi hiccup), start over from it. */
const OFFSET_RESET_MS = 500;
/** Snapshots older than this behind the newest are thrown away. */
const KEEP_MS = 1000;

export class SnapshotBuffer {
  /** Received snapshots, oldest first, no two with the same tick. */
  private readonly snapshots: SnapshotFields[] = [];
  /** My clock minus the host's game time (tick × 50 ms), in ms. Undefined until the first one. */
  private offset: number | undefined;
  /** Frames drawn so far, and how many of them had no newer snapshot to slide towards (held). */
  private samples = 0;
  private held = 0;

  constructor(private readonly delayMs = INTERPOLATION_DELAY_MS) {}

  /** The newest snapshot received, if any. */
  get latest(): SnapshotFields | undefined {
    return this.snapshots.at(-1);
  }

  /**
   * The share of frames (0–1) where the next snapshot hadn't arrived yet, so players were held
   * still instead of sliding. 0 = the buffer always had a snapshot ahead; high = it's too short
   * for this network's jitter. Undefined before anything was drawn.
   */
  get heldRatio(): number | undefined {
    return this.samples === 0 ? undefined : this.held / this.samples;
  }

  /**
   * Adds a snapshot that arrived at `arrivedMs` (my clock). Returns false and ignores it if it's
   * not newer than one already held: relay messages can arrive out of order.
   */
  push(snapshot: SnapshotFields, arrivedMs: number): boolean {
    const newest = this.latest;
    if (newest && snapshot.tick <= newest.tick) return false;
    this.snapshots.push(snapshot);

    const gap = arrivedMs - snapshot.tick * TICK_MS;
    if (this.offset === undefined || Math.abs(gap - this.offset) > OFFSET_RESET_MS) {
      this.offset = gap;
    } else {
      this.offset += (gap - this.offset) * OFFSET_SMOOTHING; // move 10 % of the way each time
    }

    const oldestKept = snapshot.tick - KEEP_MS / TICK_MS;
    while (this.snapshots.length > 2 && this.snapshots[0]!.tick < oldestKept) {
      this.snapshots.shift();
    }
    return true;
  }

  /**
   * Where everyone should be drawn at `nowMs` (my clock), in engine units.
   * Undefined before the first snapshot.
   */
  sample(nowMs: number): SnapshotPlayer[] | undefined {
    const newest = this.latest;
    if (!newest || this.offset === undefined) return undefined;
    // The host's game time to draw, in ticks (fractional: 120.4 = 40 % of the way to tick 121).
    const renderTick = (nowMs - this.offset - this.delayMs) / TICK_MS;
    this.samples += 1;

    // Find the pair of snapshots either side of renderTick.
    let before = this.snapshots[0]!;
    if (renderTick <= before.tick) return [...before.players]; // older than anything held
    for (const after of this.snapshots) {
      if (after.tick >= renderTick) {
        const t = (renderTick - before.tick) / (after.tick - before.tick);
        return blend(before, after, t);
      }
      before = after;
    }
    // Newer than the newest snapshot (the next one is late): hold everyone where they last were
    // rather than guessing ahead. Guessing ("extrapolation") looks wrong when someone stops.
    this.held += 1;
    return [...newest.players];
  }
}

/**
 * Players part-way between two snapshots (t = 0 → `a`, t = 1 → `b`). The player list comes from
 * `b`; someone who wasn't in `a` yet (they just joined) is simply drawn where `b` has them.
 */
function blend(a: SnapshotFields, b: SnapshotFields, t: number): SnapshotPlayer[] {
  return b.players.map((to) => {
    const from = a.players.find((p) => p.id === to.id);
    if (!from) return to;
    // `...to` keeps the newer snapshot's other fields (hat, shirt); only the position is blended.
    return { ...to, x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  });
}
