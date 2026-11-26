/**
 * A guest's side of input: decides WHEN to send the keys I'm holding to the host, and measures how
 * long the host takes to act on them.
 *
 * Sending every frame would be 60–144 messages a second, each one a Lambda call. But keys change
 * rarely: you press W, hold it for two seconds, let go. So a message goes out only when the keys
 * change, at most once per 100 ms (≤ 10/s, architecture §4). The host keeps using the last keys it
 * heard until new ones arrive. The 100 ms gap is counted between CHANGES only, so a keepalive that
 * happened to go out just before a key press doesn't hold the press back (with prediction, that
 * wait would show as my own player starting late).
 *
 * The same messages carry the hat and shirt I picked in the lobby (S2-01): picking one counts as a
 * change, so it goes out at once, and the host's engine applies it.
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
import type { PlayerInput } from "@sundo/engine";
import type { InputFields } from "@sundo/server/messages";
import type { TickInput } from "./prediction.ts";

/** At most one input message per 100 ms (10 a second). */
export const INPUT_MIN_GAP_MS = 100;
/** Repeat unchanged keys once a second, in case a message was lost. */
export const INPUT_KEEPALIVE_MS = 1000;

/** Same keys (incl. E and 1–4) AND same look (hat, shirt): anything different is worth sending. */
const sameKeys = (a: PlayerInput, b: PlayerInput) =>
  a.up === b.up &&
  a.down === b.down &&
  a.left === b.left &&
  a.right === b.right &&
  a.hat === b.hat &&
  a.shirt === b.shirt &&
  !!a.call === !!b.call && // `!!` so "not sent" and false count as the same
  a.emote === b.emote; // S2-06: pressing (or letting go of) 1–4 is a change

export class InputSender {
  private seq = 0;
  /** The keys in the last message sent (undefined before the first). */
  private lastKeys: PlayerInput | undefined;
  private lastSentAt = -Infinity;
  /** When the keys last changed in a message sent (keepalives don't count): for the 100 ms gap. */
  private lastChangeAt = -Infinity;
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
   * undefined if nothing needs sending yet. A change that comes too soon after the last change
   * isn't lost: the keys still differ from `lastKeys`, so it goes out as soon as the gap is over.
   */
  update(keys: PlayerInput, nowMs: number): InputFields | undefined {
    const changed = !this.lastKeys || !sameKeys(keys, this.lastKeys);
    // A change waits 100 ms after the last change; unchanged keys repeat once a second.
    const waited = changed ? nowMs - this.lastChangeAt : nowMs - this.lastSentAt;
    if (waited < (changed ? INPUT_MIN_GAP_MS : INPUT_KEEPALIVE_MS)) return undefined;

    this.seq += 1;
    if (changed) this.lastChangeAt = nowMs;
    this.lastKeys = keys;
    this.lastSentAt = nowMs;
    this.sentAt.set(this.seq, nowMs);
    // If acks stop coming (host gone), don't let the map grow forever: forget the oldest.
    if (this.sentAt.size > 100) this.sentAt.delete(this.sentAt.keys().next().value!);
    const { up, down, left, right, hat, shirt, call } = keys;
    const message: { -readonly [K in keyof InputFields]: InputFields[K] } = {
      seq: this.seq,
      up,
      down,
      left,
      right,
    };
    // Only include the look when there is one (no `hat: undefined` on the wire).
    if (hat !== undefined) message.hat = hat;
    if (shirt !== undefined) message.shirt = shirt;
    if (call) message.call = true; // only while E is held (S2-03)
    return message;
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
