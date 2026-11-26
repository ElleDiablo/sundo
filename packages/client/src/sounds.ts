/**
 * Little sounds made in code with the Web Audio API, so there's no audio file to download, license
 * or keep in the repo. Placeholder sounds until real ones are recorded (S3).
 *
 * How Web Audio works, in short: an AudioContext is a graph of nodes. An oscillator makes a pure
 * tone at a frequency (Hz); a gain node turns the volume up and down over time (the "envelope");
 * the context's `destination` is the speakers. Each note is oscillator → gain → speakers.
 *
 * Browsers only let a page make sound after the player has clicked or pressed something on it.
 * Every sound here plays after "Start walking" was clicked, so that's already true.
 */

/** One AudioContext for the whole page, made on the first sound (making one is not free). */
let context: AudioContext | undefined;

function audio(): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined; // very old browser, or tests
  context ??= new AudioContext();
  return context;
}

/**
 * Plays one soft note: `freq` Hz, starting `at` seconds from now, fading out over `length` seconds.
 * The volume jumps up in 10 ms and then decays exponentially, which sounds like a small bell.
 */
function note(ctx: AudioContext, freq: number, at: number, length: number, volume = 0.15): void {
  const start = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  osc.type = "triangle"; // softer than a square wave, brighter than a pure sine
  osc.frequency.value = freq;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start); // exponential ramps can't start at exactly 0
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + length + 0.05);
}

/** A child got home (S2-04): three rising notes, C–E–G, like a door chime. */
export function playKidHome(): void {
  const ctx = audio();
  if (!ctx) return;
  void ctx.resume(); // in case the browser suspended it; `void` = don't wait for the promise
  note(ctx, 523.25, 0, 0.5); // C5
  note(ctx, 659.25, 0.12, 0.5); // E5
  note(ctx, 783.99, 0.24, 0.8); // G5
}
