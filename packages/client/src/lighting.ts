/**
 * The night's light (look pass; replaces S3-01's darkness.ts and the two flat night tints).
 *
 * How it works: a "light map". Every frame a screen-sized picture (a Phaser RenderTexture) is
 * filled with the AMBIENT colour (deep night blue in the round, moonlight in the lobby), then every
 * light is ADDED on top of it: warm lamp light at doorways and windows, a pale halo around each
 * tanod, each flashlight's cone, a soft wash over the safe zones. The finished light map is drawn
 * over the world with the MULTIPLY blend mode: each pixel of the world is multiplied by the light
 * there. Where the light map is white the world shows at full colour; where it's dark blue the
 * world is dim and blue; where a lamp adds orange, the world turns warm. Light adds up but can't go
 * past white, so a bright spot tints the art without washing it out.
 *
 * This is the same idea as the art spike (which did it pixel by pixel on the CPU); here the GPU
 * does it, by drawing a few soft textures.
 *
 * The light shapes (a round glow and the flashlight cone) are drawn once at start-up into canvas
 * textures, with smooth gradients: the old 4-step banded shapes showed hard rings on walls.
 *
 * Lightning: flash() brightens the ambient colour for a moment and lets it fade over ~1.5 s
 * (a soft fade, never a strobe).
 *
 * The layer never scrolls (scroll factor 0), so world positions are turned into screen positions by
 * subtracting the camera's top-left corner, rounded to whole pixels.
 */
import Phaser from "phaser";

/** A round light at a world position (pixels): `size` = diameter, `color` = 0xRRGGBB, `strength` 0–1+. */
export interface Glow {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: number;
  readonly strength: number;
}
/** A flashlight at a world position (pixels), pointing at `angle` (radians, 0 = right). */
export interface Beam {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}
/** A softly lit rectangle in world pixels (a safe zone). */
export interface Area {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How far the drawn cone reaches, in pixels: the engine's LIGHT_RANGE is 5 tiles = 80 px. */
const CONE_LENGTH = 84;
/** The cone is fully bright up to 22° off its middle, then fades out by 35° (the engine's edge). */
const CONE_INNER = (22 * Math.PI) / 180;
const CONE_OUTER = (35 * Math.PI) / 180;
/** Flashlight colour: a slightly warm white, like an old incandescent torch. */
const BEAM_COLOR = 0xfff4d8;
/** Safe zones: a soft warm wash, enough to read as "lit and safe" under the lamps. */
const ZONE_COLOR = 0x8a7a5c;

/** Fades smoothly from 0 at `a` to 1 at `b` (the "smoothstep" curve: no hard edge at either end). */
function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Splits 0xRRGGBB into its three parts, 0–255 each. */
function rgb(color: number): [number, number, number] {
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255];
}

/** Mixes two colours: t = 0 gives `a`, t = 1 gives `b`. */
export function mix(a: number, b: number, t: number): number {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  return (m(ar, br) << 16) | (m(ag, bg) << 8) | m(ab, bb);
}

/**
 * Draws the light shapes into canvas textures once (white; the colour comes from a tint and the
 * strength from the alpha when each is stamped):
 *   "light-round"  64×64 round glow, bright in the middle, (1 − distance)² towards the edge
 *   "light-cone"   the flashlight cone, apex at the middle of the left edge, pointing right
 *   "light-soft"   32×32 square with soft edges, stretched over the safe zones
 *   "vignette"     the screen, dark at the corners, for a multiply over everything
 */
function makeTextures(scene: Phaser.Scene): void {
  const shape = (
    key: string,
    width: number,
    height: number,
    alphaAt: (x: number, y: number) => number,
    color = 255,
  ) => {
    if (scene.textures.exists(key)) return;
    const canvas = scene.textures.createCanvas(key, width, height);
    if (!canvas) return;
    const ctx = canvas.getContext();
    const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const a = alphaAt(x + 0.5, y + 0.5);
        image.data[i] = image.data[i + 1] = image.data[i + 2] = color;
        image.data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
      }
    ctx.putImageData(image, 0, 0);
    canvas.refresh(); // upload the pixels to the GPU
  };

  shape("light-round", 64, 64, (x, y) => {
    const d = Math.hypot(x - 32, y - 32) / 32;
    return d >= 1 ? 0 : (1 - d) ** 2;
  });

  const coneHeight = 2 * Math.ceil(CONE_LENGTH * Math.sin(CONE_OUTER)) + 2;
  shape("light-cone", CONE_LENGTH + 2, coneHeight, (x, y) => {
    const dy = y - coneHeight / 2;
    const d = Math.hypot(x, dy) / CONE_LENGTH;
    if (d >= 1) return 0;
    const angle = Math.atan2(Math.abs(dy), x); // 0 = straight ahead
    const edge = 1 - smoothstep(CONE_INNER, CONE_OUTER, angle); // soft sides
    const fall = (1 - d) ** 1.2; // dimmer further away, like the art spike
    const hot = 0.35 * Math.max(0, 1 - d * 2.5) * (1 - smoothstep(0, CONE_INNER, angle)); // bright core
    return edge * fall + hot;
  });

  shape("light-soft", 32, 32, (x, y) => {
    const edge = (v: number) => smoothstep(0, 8, Math.min(v, 32 - v));
    return edge(x) * edge(y);
  });

  const { width, height } = scene.scale;
  // The vignette multiplies, so it's drawn in grey levels (alpha 1): 1 in the middle, ~0.6 in the
  // corners, as in the art spike.
  if (!scene.textures.exists("vignette")) {
    const canvas = scene.textures.createCanvas("vignette", width, height);
    if (canvas) {
      const ctx = canvas.getContext();
      const image = ctx.createImageData(width, height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const u = (x - width / 2) / (width / 2);
          const v = (y - height / 2) / (height / 2);
          const k = Math.round(255 * (1 - 0.42 * Math.min(1, (u * u + v * v) * 0.55)));
          const i = (y * width + x) * 4;
          image.data[i] = image.data[i + 1] = image.data[i + 2] = k;
          image.data[i + 3] = 255;
        }
      ctx.putImageData(image, 0, 0);
      canvas.refresh();
    }
  }
}

export class Lighting {
  private readonly layer: Phaser.GameObjects.RenderTexture;
  private readonly vignette: Phaser.GameObjects.Image;
  /** Lightning: 1 right after a flash, fading to 0. */
  private flashLevel = 0;

  constructor(scene: Phaser.Scene, depth: number) {
    makeTextures(scene);
    const { width, height } = scene.scale;
    this.layer = scene.add
      .renderTexture(0, 0, width, height)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(depth)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    this.vignette = scene.add
      .image(0, 0, "vignette")
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(depth + 0.01)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
  }

  /** A lightning flash: the ambient light jumps up and fades back over about 1.5 s. */
  flash(): void {
    this.flashLevel = 1;
  }

  /** How bright the lightning still is, 0–1 (for anything else that should flash with it). */
  get flashing(): number {
    return this.flashLevel;
  }

  /**
   * Redraws the light map for this frame. `ambient` is the colour everything gets with no light on
   * it; `vignette` switches the dark corners on or off; `dt` (seconds) fades the lightning.
   */
  draw(
    camera: Phaser.Cameras.Scene2D.Camera,
    ambient: number,
    vignette: boolean,
    dt: number,
    glows: readonly Glow[],
    beams: readonly Beam[],
    areas: readonly Area[],
  ): void {
    this.flashLevel = Math.max(0, this.flashLevel - dt / 1.5);
    // Lightning lifts the ambient towards a cold blue-white (eased, so it fades out gently).
    const sky = mix(ambient, 0xa8b8f0, 0.8 * this.flashLevel ** 2);
    this.vignette.setVisible(vignette);
    // World → screen: subtract the visible area's top-left corner.
    const ox = Math.round(camera.worldView.x);
    const oy = Math.round(camera.worldView.y);
    const add = Phaser.BlendModes.ADD;
    // fill() takes the colour and paints the whole texture with it (replacing what was there).
    this.layer.clear().fill(sky, 1);
    for (const a of areas) {
      this.layer.stamp("light-soft", undefined, a.x - ox, a.y - oy, {
        originX: 0,
        originY: 0,
        scaleX: a.width / 32,
        scaleY: a.height / 32,
        tint: ZONE_COLOR,
        blendMode: add,
      });
    }
    for (const g of glows) {
      this.layer.stamp("light-round", undefined, Math.round(g.x) - ox, Math.round(g.y) - oy, {
        scale: g.size / 64,
        tint: g.color,
        alpha: Math.min(1, g.strength),
        blendMode: add,
      });
    }
    for (const b of beams) {
      this.layer.stamp("light-cone", undefined, Math.round(b.x) - ox, Math.round(b.y) - oy, {
        originX: 0,
        originY: 0.5, // the apex sits on the torch
        rotation: b.angle,
        tint: BEAM_COLOR,
        blendMode: add,
      });
    }
    this.layer.render();
  }
}
