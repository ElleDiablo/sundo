/**
 * Fixed timestep: turns the browser's uneven frames into exact 50 ms engine ticks.
 *
 * The screen redraws whenever the browser likes (60, 120 or 144 times a second, and slower when
 * the tab is busy). The engine must tick exactly every 50 ms (ADR-0004), or two machines would
 * disagree about where everyone is. So each frame adds its real time to a "bank" (accumulator)
 * and spends it in whole 50 ms ticks; the leftover waits for the next frame.
 *
 *   frame  16 ms → bank 16 → 0 ticks, leftover 16
 *   frame  16 ms → bank 32 → 0 ticks, leftover 32
 *   frame  16 ms → bank 48 → 0 ticks, leftover 48
 *   frame  16 ms → bank 64 → 1 tick,  leftover 14
 *
 * `alpha` (leftover ÷ 50) says how far we are between the last tick and the next one, so the
 * client can draw characters part-way between their two most recent positions. That's what makes
 * 20 ticks/s look smooth on a 60 Hz or 144 Hz screen.
 */
export interface FixedStep {
  readonly tickMs: number;
  /** Never run more than this many ticks in one frame (after a long pause, skip instead). */
  readonly maxTicksPerFrame: number;
  /** Banked time not yet spent on a tick, in ms. */
  accumulator: number;
}

export function createFixedStep(tickMs: number, maxTicksPerFrame = 5): FixedStep {
  return { tickMs, maxTicksPerFrame, accumulator: 0 };
}

/** Adds one frame's time. Returns how many ticks to run now and how far into the next one we are. */
export function advance(clock: FixedStep, frameMs: number): { ticks: number; alpha: number } {
  clock.accumulator += Math.max(0, frameMs);
  let ticks = Math.floor(clock.accumulator / clock.tickMs);
  clock.accumulator -= ticks * clock.tickMs;
  if (ticks > clock.maxTicksPerFrame) {
    // The tab was hidden or the machine stalled: catching up on hundreds of ticks at once would
    // freeze the page ("spiral of death"). Run a few and drop the rest.
    ticks = clock.maxTicksPerFrame;
    clock.accumulator = 0;
  }
  return { ticks, alpha: clock.accumulator / clock.tickMs };
}
