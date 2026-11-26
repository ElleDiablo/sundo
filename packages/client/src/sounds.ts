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
  const raining = rainWanted;
  if (!muted) setRain(false); // switching off: silence the rain now…
  muted = !muted;
  localStorage.setItem("sundo:muted", muted ? "1" : "0");
  if (!muted && raining) setRain(true); // …and switching back on mid-storm brings it back
  rainWanted = raining;
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

/**
 * A dog barking (S3-08): two short "woofs", square waves that drop in pitch, like a small dog.
 * `volume` is lower for dogs further away.
 */
export function playBark(volume: number): void {
  const ctx = audio();
  if (!ctx || volume <= 0.002) return;
  void ctx.resume();
  const woof = (at: number) => {
    const start = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(520, start);
    osc.frequency.exponentialRampToValueAtTime(260, start + 0.12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.2);
  };
  woof(0);
  woof(0.22);
}

// ─── Look pass: the storm, footsteps and crying children ──────────────────────────────────────
//
// These use NOISE as well as tones. White noise = random samples, every frequency at once (a
// hiss). Filtered, it becomes many natural sounds: keep only the highs and it's rain; keep only the
// lows and it's a rumble (thunder); a 40 ms burst of the middle is a footstep on dirt. The noise is
// made once (2 s of random samples in an AudioBuffer) and reused by every sound.
//
// Sounds from the world are also PANNED: a StereoPannerNode moves them left or right (−1 … 1), so a
// child crying to my left is heard in my left ear.

let noiseBuffer: AudioBuffer | undefined;

/** 2 s of white noise, made on first use. */
function noise(ctx: AudioContext): AudioBuffer {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

/** A node that pans what goes into it (−1 = left … 1 = right) and sends it to the speakers. */
function panned(ctx: AudioContext, pan: number): AudioNode {
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(ctx.destination);
  return panner;
}

/** The rain's hiss while it plays: its source and its volume node, to fade it out again. */
let rain: { source: AudioBufferSourceNode; gain: GainNode } | undefined;
/** Should it be raining (the storm is on), even if the sound is off right now? */
let rainWanted = false;

/**
 * Starts or stops the rain (look pass): looping noise through a band of high frequencies (the
 * hiss of drops on leaves and roofs), faded in and out over 2 s so it never starts with a click.
 */
export function setRain(on: boolean): void {
  rainWanted = on;
  if (!on) {
    const playing = rain;
    rain = undefined;
    if (!playing || !context) return;
    const t = context.currentTime;
    playing.gain.gain.setTargetAtTime(0, t, 0.6); // fade towards silence…
    playing.source.stop(t + 3); // …then stop the source
    return;
  }
  const ctx = audio();
  if (!ctx || rain) return;
  void ctx.resume();
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx);
  source.loop = true;
  const high = ctx.createBiquadFilter();
  high.type = "highpass"; // drop the lows: no rumble, just hiss
  high.frequency.value = 900;
  const low = ctx.createBiquadFilter();
  low.type = "lowpass"; // soften the very top so it isn't harsh
  low.frequency.value = 6500;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.gain.setTargetAtTime(0.045, ctx.currentTime, 0.7); // fade in
  source.connect(high).connect(low).connect(gain).connect(ctx.destination);
  source.start();
  rain = { source, gain };
}

/**
 * Thunder (look pass): three overlapping bursts of low noise. Each burst's filter closes from 900
 * to 90 Hz as it fades, so the first crack is brighter and the roll that follows is a dull rumble.
 */
export function playThunder(): void {
  const ctx = audio();
  if (!ctx) return;
  void ctx.resume();
  const burst = (at: number, length: number, volume: number) => {
    const start = ctx.currentTime + at;
    const source = ctx.createBufferSource();
    source.buffer = noise(ctx);
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(900, start);
    filter.frequency.exponentialRampToValueAtTime(90, start + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(start, Math.random()); // start somewhere random in the noise: each roll differs
    source.stop(start + length + 0.1);
  };
  burst(0, 1.2, 0.35);
  burst(0.25, 2.6, 0.3);
  burst(0.9, 3.2, 0.2);
}

/**
 * One footstep (look pass): a 50 ms burst of mid-range noise (the scuff) over a short low thump.
 * The scuff's pitch varies a little each step so walking doesn't sound like a machine. `volume`
 * 0–0.1 (quieter further away), `pan` −1 … 1.
 */
export function playStep(volume: number, pan = 0): void {
  const ctx = audio();
  if (!ctx || volume <= 0.002) return;
  void ctx.resume();
  const out = panned(ctx, pan);
  const start = ctx.currentTime;
  const source = ctx.createBufferSource();
  source.buffer = noise(ctx);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 500 + Math.random() * 400;
  band.Q.value = 1.2;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.06);
  source.connect(band).connect(gain).connect(out);
  source.start(start, Math.random() * 1.5);
  source.stop(start + 0.08);
  // The thump: a quick sine that drops from 110 to 60 Hz.
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(110, start);
  osc.frequency.exponentialRampToValueAtTime(60, start + 0.05);
  const thump = ctx.createGain();
  thump.gain.setValueAtTime(0.0001, start);
  thump.gain.exponentialRampToValueAtTime(volume * 0.8, start + 0.004);
  thump.gain.exponentialRampToValueAtTime(0.0001, start + 0.06);
  osc.connect(thump).connect(out);
  osc.start(start);
  osc.stop(start + 0.08);
}

/**
 * A lost child crying (look pass): one sob, "uu-waaah", then a catch of breath. A sawtooth (a
 * buzzy tone, like a voice) wavers (vibrato: its pitch swings 6 times a second), rises and then
 * falls in pitch, through a filter that keeps the "aah" vowel's band around 1.1 kHz. Then two
 * short sniffs of filtered noise. `pitch` (around 1) makes each child's voice a little different;
 * `volume` 0–0.1 (quieter further away), `pan` −1 … 1.
 */
export function playCry(volume: number, pan = 0, pitch = 1): void {
  const ctx = audio();
  if (!ctx || volume <= 0.002) return;
  void ctx.resume();
  const out = panned(ctx, pan);
  const start = ctx.currentTime;
  const base = 420 * pitch;

  const voice = ctx.createOscillator();
  voice.type = "sawtooth";
  voice.frequency.setValueAtTime(base * 0.85, start); // "uu…"
  voice.frequency.linearRampToValueAtTime(base * 1.25, start + 0.25); // "…waa…"
  voice.frequency.linearRampToValueAtTime(base * 0.8, start + 1.0); // "…aah" falling away
  // The vibrato: a slow oscillator (6 Hz) added to the voice's frequency, ±18 Hz.
  const wobble = ctx.createOscillator();
  wobble.frequency.value = 6;
  const depth = ctx.createGain();
  depth.gain.value = 18 * pitch;
  wobble.connect(depth).connect(voice.frequency);
  const vowel = ctx.createBiquadFilter();
  vowel.type = "bandpass";
  vowel.frequency.value = 1100;
  vowel.Q.value = 2.5;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.12);
  gain.gain.setValueAtTime(volume, start + 0.6);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.05);
  voice.connect(vowel).connect(gain).connect(out);
  voice.start(start);
  wobble.start(start);
  voice.stop(start + 1.1);
  wobble.stop(start + 1.1);

  // Two sniffs: 70 ms of high noise each, after the sob.
  for (const at of [1.25, 1.45]) {
    const s = start + at;
    const source = ctx.createBufferSource();
    source.buffer = noise(ctx);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(volume * 0.5, s + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.08);
    source.connect(band).connect(g).connect(out);
    source.start(s, Math.random());
    source.stop(s + 0.1);
  }
}
