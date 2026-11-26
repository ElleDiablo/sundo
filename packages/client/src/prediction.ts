/**
 * Client-side prediction: a guest moves their own player at once instead of waiting for the host.
 *
 * Without it (S1-05), a guest's key press travels guest → relay → host's engine → snapshot →
 * relay → guest before their own tanod moves: about 220–330 ms, which feels like walking in mud.
 *
 * The fix uses the fact that the engine is deterministic (ADR-0004): the guest runs the SAME
 * step() on its own player, with the same keys the host will get, and draws that result straight
 * away. The host is still the boss (ADR-0001): every snapshot says where the host really has me,
 * and the guest re-bases on it ("reconciliation"):
 *
 *   1. Start from my position in the snapshot (the truth, but a round trip old).
 *   2. Throw away the local ticks the host has already applied: it says how far it got with
 *      `acks[seat]` (the last input seq it has) and `ackTicks[seat]` (how many ticks it has
 *      applied that input for).
 *   3. Replay the ticks it hasn't applied yet, on top of the snapshot position.
 *
 * If the host agrees with what I predicted (it nearly always does: same map, same rules), the
 * replayed position equals the one I already drew and nothing visible happens. If it doesn't
 * (an input arrived a little later than I assumed, so the host applied it for one tick fewer),
 * the difference is a few units; it's faded out over ~100 ms ("error smoothing") instead of
 * snapping, so small corrections are invisible.
 *
 * Why ackTicks is needed: a guest sends its keys only when they CHANGE (InputSender), and the
 * host keeps applying the last keys it heard, tick after tick. "The host has my input #7" alone
 * doesn't say whether it has walked me 2 ticks or 20 ticks with it. The tick count does.
 *
 * Only MY player is predicted. Players don't push each other in the engine (yet), so my movement
 * doesn't depend on anyone else and can be computed alone. Other players are still drawn from
 * snapshot interpolation (interpolation.ts).
 */
import { step, type GameState, type PlayerInput, type TileMap } from "@sundo/engine";

/** The input in effect for one local tick: the keys AND the seq of the message that sent them. */
export interface TickInput {
  readonly seq: number;
  readonly keys: PlayerInput;
}

/** What the host has done with my inputs, read from a snapshot. */
export interface HostView {
  /** Where the host has my player at the snapshot's tick, in engine units. */
  readonly x: number;
  readonly y: number;
  /** The last input seq from me the host has applied (snapshot acks[seat]). */
  readonly ackSeq: number;
  /** How many ticks the host has applied that input for (snapshot ackTicks[seat]). */
  readonly ackTicks: number;
}

/** Corrections fade out with this time constant: after 100 ms ~37 % is left, after 300 ms ~5 %. */
export const SMOOTHING_MS = 100;
/** A correction bigger than this (2 tiles) is a real disagreement: jump there, don't glide. */
export const SNAP_UNITS = 2000;
/** Keep at most this many unconfirmed ticks (10 s). If the host goes quiet, stop growing. */
const MAX_HISTORY = 200;

const NO_KEYS: PlayerInput = { up: false, down: false, left: false, right: false };

export class Predictor {
  /** My predicted state (a game with only me in it). Undefined until the first snapshot. */
  private state: GameState | undefined;
  /** The predicted state one tick ago, so the scene can draw between ticks. */
  private previous: GameState | undefined;
  /** Local ticks the host hasn't confirmed yet, oldest first: what to replay on a snapshot. */
  private history: TickInput[] = [];
  /** Correction still being faded out, in units: added to where I'm drawn. */
  private errorX = 0;
  private errorY = 0;

  constructor(
    private readonly map: TileMap,
    private readonly id: string,
  ) {}

  /** True once a snapshot has told me where I start; before that there's nothing to predict. */
  get ready(): boolean {
    return this.state !== undefined;
  }

  /** How many ticks are waiting for the host to confirm them (for tests and the debug hook). */
  get pending(): number {
    return this.history.length;
  }

  /**
   * Runs one local tick (called 20 times a second, like the host's engine) with the input the
   * host will also get: the last one SENT, not the keys held right now. If I pressed a key in the
   * 100 ms gap InputSender waits between messages, the host won't see it until it's sent either,
   * so predicting it early would only cause a correction.
   */
  tick(input: TickInput | undefined): void {
    if (!this.state) return;
    const entry = input ?? { seq: 0, keys: NO_KEYS };
    this.previous = this.state;
    this.state = step(this.state, { [this.id]: entry.keys }).state;
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  /** A snapshot arrived: re-base on where the host has me and replay what it hasn't seen yet. */
  reconcile(host: HostView): void {
    // 1. Drop the ticks the host has already applied. History is in seq order, so they're all at
    //    the front: every tick of an older input, then the first `ackTicks` ticks of the acked one.
    //    If the host applied the acked input for MORE ticks than I did (my next one reached it
    //    late), all of mine are dropped and the extra steps show up as a small correction.
    let applied = 0;
    let cut = 0;
    while (cut < this.history.length) {
      const { seq } = this.history[cut]!;
      if (seq < host.ackSeq) cut++;
      else if (seq === host.ackSeq && applied < host.ackTicks) {
        applied++;
        cut++;
      } else break;
    }
    this.history.splice(0, cut);

    // 2. Start from the host's position and replay the rest. Only `players` matters for
    //    movement; tick 0 is fine because step() never reads the tick number. Phase "round" and
    //    a placeholder look: prediction is only about WHERE I am (looks are drawn from my own
    //    pick or the host's snapshot), and in "round" step() ignores looks and runs no countdown.
    let state: GameState = {
      tick: 0,
      map: this.map,
      phase: "round",
      countdown: null,
      rngState: 0,
      kidSpots: [],
      kids: [],
      players: [{ id: this.id, x: host.x, y: host.y, hat: 0, shirt: 0 }],
    };
    let previous = state;
    for (const { keys } of this.history) {
      previous = state;
      state = step(state, { [this.id]: keys }).state;
    }

    // 3. Whatever moved because of the correction is added to the error, so the drawn position
    //    doesn't jump this frame; it then fades out in decay().
    const before = this.state ? this.me(this.state) : undefined;
    const after = this.me(state);
    if (before) {
      this.errorX += before.x - after.x;
      this.errorY += before.y - after.y;
      if (Math.hypot(this.errorX, this.errorY) > SNAP_UNITS) {
        this.errorX = 0; // too far to glide: jump straight to the corrected spot
        this.errorY = 0;
      }
    }
    this.state = state;
    this.previous = previous;
  }

  /** Fades the correction a little each screen frame (`frameMs` = time since the last one). */
  decay(frameMs: number): void {
    const keep = Math.exp(-Math.max(0, frameMs) / SMOOTHING_MS);
    this.errorX *= keep;
    this.errorY *= keep;
    if (Math.abs(this.errorX) < 1) this.errorX = 0; // under one unit: done
    if (Math.abs(this.errorY) < 1) this.errorY = 0;
  }

  /**
   * Where to draw me: `alpha` of the way from the previous tick to the current one (0–1, from the
   * fixed timestep), plus whatever correction is still fading out. Undefined until ready.
   */
  position(alpha: number): { x: number; y: number } | undefined {
    if (!this.state || !this.previous) return undefined;
    const now = this.me(this.state);
    const then = this.me(this.previous);
    return {
      x: then.x + (now.x - then.x) * alpha + this.errorX,
      y: then.y + (now.y - then.y) * alpha + this.errorY,
    };
  }

  private me(state: GameState) {
    return state.players[0]!; // the predicted game only ever holds me
  }
}
