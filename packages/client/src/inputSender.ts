/**
 * A guest's side of input: decides WHEN to send the keys I'm holding to the host, and measures how
 * long the host takes to act on them.
 *
 * Sending every frame would be 60–144 messages a second, each one a Lambda call. But keys change
 * rarely: you press W, hold it for two seconds, let go. So a message goes out only when the keys
 * change, at most once per 100 ms (≤ 10/s, architecture §4). The host keeps using the last keys it
 * heard until new ones arrive.
 *
 * A keepalive repeats the current keys once a second even when nothing changed. If one message
 * was ever lost (a throttled or failed Lambda), the host would otherwise keep a guest walking
 * forever; with the keepalive the mistake lasts at most a second.
 *
 * Every message carries `seq`, a number that goes up by one each time. Messages pass through
 * separate Lambda calls that can finish out of order, so the host ignores any seq lower than one
 * it already has. The host also reports back the last seq it applied (snapshot `acks`), which is
 * how `acked()` measures the round trip: my key press → relay → host's engine → snapshot → relay → me.
 */
import type { MoveInput } from "@sundo/engine";
import type { InputFields } from "@sundo/server/messages";
import type { TickInput } from "./prediction.ts";

/** At most one input message per 100 ms (10 a second). */
export const INPUT_MIN_GAP_MS = 100;
/** Repeat unchanged keys once a second, in case a message was lost. */
export const INPUT_KEEPALIVE_MS = 1000;

const sameKeys = (a: MoveInput, b: MoveInput) =>
  a.up === b.up && a.down === b.down && a.left === b.left && a.right === b.right;

export class InputSender {
  private seq = 0;
  /** The keys in the last message sent (undefined before the first). */
  private lastKeys: MoveInput | undefined;
  private lastSentAt = -Infinity;
  /** When each not-yet-acknowledged message was sent: seq → time in ms. */
  private readonly sentAt = new Map<number, number>();

  /**
   * The last message sent (seq + keys), or undefined before the first. This is what the host is
   * (or soon will be) applying for me, so it's what client-side prediction steps with (NET-01).
   */
  get current(): TickInput | undefined {
    return this.lastKeys && { seq: this.seq, keys: this.lastKeys };
  }

  /**
   * Called every frame with the keys held right now. Returns the message to send now, or
   * undefined if nothing needs sending yet. A change that comes too soon after the last message
   * isn't lost: the keys still differ from `lastKeys`, so it goes out as soon as the gap is over.
   */
  update(keys: MoveInput, nowMs: number): InputFields | undefined {
    const changed = !this.lastKeys || !sameKeys(keys, this.lastKeys);
    const waited = nowMs - this.lastSentAt;
    if (waited < (changed ? INPUT_MIN_GAP_MS : INPUT_KEEPALIVE_MS)) return undefined;

    this.seq += 1;
    this.lastKeys = keys;
    this.lastSentAt = nowMs;
    this.sentAt.set(this.seq, nowMs);
    // If acks stop coming (host gone), don't let the map grow forever: forget the oldest.
    if (this.sentAt.size > 100) this.sentAt.delete(this.sentAt.keys().next().value!);
    const { up, down, left, right } = keys;
    return { seq: this.seq, up, down, left, right };
  }

  /**
   * The host says it has applied my inputs up to `seq`. Returns the round trip for that message
   * in ms the first time it's acknowledged, otherwise undefined (later snapshots repeat the ack).
   */
  acked(seq: number, nowMs: number): number | undefined {
    const sent = this.sentAt.get(seq);
    // Everything up to seq is now acknowledged; drop it all so it's only measured once.
    for (const s of this.sentAt.keys()) if (s <= seq) this.sentAt.delete(s);
    return sent === undefined ? undefined : nowMs - sent;
  }
}

/** Keeps the last few round-trip times and summarises them (median and 95th percentile). */
export class LatencyStats {
  private readonly samples: number[] = [];
  constructor(private readonly keep = 50) {}

  add(ms: number): void {
    this.samples.push(ms);
    if (this.samples.length > this.keep) this.samples.shift();
  }

  get count(): number {
    return this.samples.length;
  }

  /** The value below which `p` (0–1) of the samples fall; e.g. 0.5 = median. */
  percentile(p: number): number | undefined {
    if (this.samples.length === 0) return undefined;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  }
}
