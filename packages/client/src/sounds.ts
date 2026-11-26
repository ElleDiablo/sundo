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

/**
 * Sound on or off (S3-05: M). Remembered in the browser (localStorage) between visits. With sound
 * off, nothing plays; the on-screen rings still warn about the tikbalang and barking dogs.
 */
let muted = typeof localStorage !== "undefined" && localStorage.getItem("sundo:muted") === "1";

/** Is the sound off? */
export function isMuted(): boolean {
  return muted;
}

/** Switches the sound on or off, and remembers it. Returns the new state (true = off). */
export function toggleMuted(): boolean {
  muted = !muted;
  localStorage.setItem("sundo:muted", muted ? "1" : "0");
  return muted;
}

function audio(): AudioContext | undefined {
  if (muted) return undefined; // sound off: every play… function returns early
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

/** Every child is home (S2-05): a rising four-note fanfare, C–E–G–C. */
export function playWin(): void {
  const ctx = audio();
  if (!ctx) return;
  void ctx.resume();
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => note(ctx, freq, i * 0.15, 0.9));
}

/** Dawn came first (S2-05): two low, falling notes. */
export function playDawn(): void {
  const ctx = audio();
  if (!ctx) return;
  void ctx.resume();
  note(ctx, 392.0, 0, 0.9, 0.12); // G4
  note(ctx, 261.63, 0.35, 1.4, 0.12); // C4
}

/** Someone was caught by the tikbalang (S3-03): a low, falling moan, a little louder if it's me. */
export function playCaught(me: boolean): void {
  const ctx = audio();
  if (!ctx) return;
  void ctx.resume();
  const volume = me ? 0.2 : 0.1;
  note(ctx, 220, 0, 0.5, volume); // A3
  note(ctx, 174.61, 0.2, 0.6, volume); // F3
  note(ctx, 116.54, 0.45, 1.2, volume); // B♭2
}

/**
 * One hoofbeat (S3-05): two quick, low thuds ("clip-clop"), sine waves at 90 and 75 Hz that die
 * away in a tenth of a second. `volume` 0–0.25 comes from hoofbeats.ts (louder = nearer).
 */
export function playHoof(volume: number): void {
  const ctx = audio();
  if (!ctx || volume <= 0.002) return;
  void ctx.resume();
  const thud = (freq: number, at: number) => {
    const start = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, start + 0.1); // a falling "thump"
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.15);
  };
  thud(90, 0);
  thud(75, 0.09);
}
