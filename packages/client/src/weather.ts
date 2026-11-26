/**
 * The storm (look pass): rain, ripples on the water, and lightning with thunder. Only during the
 * round and its win screen; the lobby is a calm night. Purely for looks and mood: nothing here
 * touches the engine, so each player's rain and lightning are their own (not in sync), which
 * doesn't matter for a storm.
 *
 * Three layers:
 *   rain      screen-space streaks (they don't scroll with the map: rain falls past the camera),
 *             drawn ABOVE the light map so they show as pale lines even in the dark
 *   ripples   tiny rings that open and fade on the paddies and the creek, in world space, also
 *             above the light map but faint, so the water seems alive even in the dark
 *   lightning every 12–25 s: Lighting.flash() lifts the ambient light for a moment, and thunder
 *             rolls in 0.6–2.5 s later (further storms = longer gap)
 *
 * Everything is drawn into two Phaser Graphics objects that are cleared and redrawn every frame,
 * one whole pixel at a time (fillRect 1×1), so the rain stays as crisp as the rest of the pixel art.
 *
 * If the player has asked their system for reduced motion, there's less rain and no flash (the
 * thunder still plays).
 */
import Phaser from "phaser";
import type { Lighting } from "./lighting.ts";
import { playThunder, setRain } from "./sounds.ts";

/** One raindrop on screen: position (screen px), speed (px/s), streak length (px). */
interface Drop {
  x: number;
  y: number;
  speed: number;
  length: number;
}
/** One ripple on the water: where (world px) and how old (seconds). */
interface Ripple {
  x: number;
  y: number;
  age: number;
}

const RAIN_COLOR = 0xa8bcdc;
const RIPPLE_COLOR = 0x7aa4bc;
/** A ripple opens over this many seconds, then it's gone. */
const RIPPLE_LIFE = 0.45;
/** Rain slants: for every pixel down, this much to the left (wind). */
const SLANT = 0.2;

export class Weather {
  private readonly rain: Phaser.GameObjects.Graphics;
  private readonly ripplesLayer: Phaser.GameObjects.Graphics;
  private readonly drops: Drop[] = [];
  private readonly ripples: Ripple[] = [];
  /** Top-left corner (world px) of every water tile, where ripples can open. */
  private readonly water: { x: number; y: number }[];
  private readonly reduced: boolean;
  /** Seconds until the next lightning, and until the thunder that follows one (or undefined). */
  private untilLightning = 8;
  private untilThunder: number | undefined;
  /** Was it stormy last frame? (To switch the rain sound on and off once, not every frame.) */
  private wasStormy = false;

  constructor(
    scene: Phaser.Scene,
    water: { x: number; y: number }[],
    rainDepth: number,
    rippleDepth: number,
  ) {
    this.water = water;
    this.reduced =
      typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.rain = scene.add.graphics().setScrollFactor(0).setDepth(rainDepth);
    this.ripplesLayer = scene.add.graphics().setDepth(rippleDepth);
    const { width, height } = scene.scale;
    // Spread the drops over the screen (and a strip to the right, since they drift left).
    const count = this.reduced ? 50 : 140;
    for (let i = 0; i < count; i++) {
      this.drops.push({
        x: Math.random() * (width + 50),
        y: Math.random() * height,
        speed: 160 + Math.random() * 100,
        length: 3 + Math.floor(Math.random() * 4),
      });
    }
  }

  /**
   * Moves the rain on by `dt` seconds and redraws it. `stormy` = is it raining at all (round and
   * win screen). `camera` places the ripples; `lighting` gets the lightning flashes.
   */
  update(
    dt: number,
    camera: Phaser.Cameras.Scene2D.Camera,
    stormy: boolean,
    lighting: Lighting,
  ): void {
    this.rain.clear();
    this.ripplesLayer.clear();
    if (stormy !== this.wasStormy) setRain(stormy); // the rain's hiss starts or stops
    this.wasStormy = stormy;
    if (!stormy) {
      this.untilThunder = undefined;
      return;
    }
    this.updateLightning(dt, lighting);
    const { width, height } = camera;

    // Rain: each streak is a short diagonal line of pixels, fading towards its tail.
    for (const d of this.drops) {
      d.y += d.speed * dt;
      d.x -= d.speed * dt * SLANT;
      if (d.y > height + 8 || d.x < -8) {
        d.y = -Math.random() * 20; // back to the top, somewhere new
        d.x = Math.random() * (width + 50);
      }
      for (let k = 0; k < d.length; k++) {
        this.rain.fillStyle(RAIN_COLOR, 0.32 - k * 0.05);
        this.rain.fillRect(Math.round(d.x + k * SLANT), Math.round(d.y - k), 1, 1);
      }
    }

    // Ripples: open a few new ones a second on water tiles that are on screen.
    const view = camera.worldView;
    const visible = this.water.filter(
      (w) => w.x + 16 > view.x && w.x < view.right && w.y + 16 > view.y && w.y < view.bottom,
    );
    const newOnes = visible.length * dt * (this.reduced ? 0.4 : 1.2); // ~1.2 per tile per second
    for (let n = newOnes; n > 0; n -= 1) {
      if (n < 1 && Math.random() > n) break; // the fractional part opens one only sometimes
      const tile = visible[Math.floor(Math.random() * visible.length)];
      if (tile) {
        this.ripples.push({
          x: tile.x + 2 + Math.floor(Math.random() * 12),
          y: tile.y + 2 + Math.floor(Math.random() * 12),
          age: 0,
        });
      }
    }
    // Draw and age them: a dot, then a 4-pixel ring (radius 1), then a wider ring (radius 2).
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i]!;
      r.age += dt;
      if (r.age >= RIPPLE_LIFE) {
        this.ripples.splice(i, 1);
        continue;
      }
      const t = r.age / RIPPLE_LIFE; // 0 → 1 over its life
      this.ripplesLayer.fillStyle(RIPPLE_COLOR, 0.4 * (1 - t));
      const radius = t < 0.2 ? 0 : t < 0.55 ? 1 : 2;
      if (radius === 0) {
        this.ripplesLayer.fillRect(r.x, r.y, 1, 1);
      } else {
        // A small diamond-ish ring: left, right, top and bottom, plus wider sides (ripples look flat).
        this.ripplesLayer.fillRect(r.x - radius - 1, r.y, 1, 1);
        this.ripplesLayer.fillRect(r.x + radius + 1, r.y, 1, 1);
        this.ripplesLayer.fillRect(r.x - radius + 1, r.y - 1, radius * 2 - 1, 1);
        this.ripplesLayer.fillRect(r.x - radius + 1, r.y + 1, radius * 2 - 1, 1);
      }
    }
  }

  /** Counts down to the next lightning, flashes, then counts down to its thunder. */
  private updateLightning(dt: number, lighting: Lighting): void {
    this.untilLightning -= dt;
    if (this.untilLightning <= 0) {
      if (!this.reduced) lighting.flash();
      this.untilThunder = 0.6 + Math.random() * 1.9;
      this.untilLightning = 12 + Math.random() * 13;
    }
    if (this.untilThunder !== undefined) {
      this.untilThunder -= dt;
      if (this.untilThunder <= 0) {
        playThunder();
        this.untilThunder = undefined;
      }
    }
  }
}
