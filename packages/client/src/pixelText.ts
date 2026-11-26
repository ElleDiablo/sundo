/**
 * How text drawn INSIDE the game (call hint, house labels, speech bubbles) looks.
 *
 * Why the old labels looked smudgy: the game draws into a 384 × 216 canvas that the browser then
 * blows up ~3× with no smoothing (`pixelArt`), so every text pixel becomes a 3 × 3 block. A normal
 * font (monospace) at 8 px is drawn with grey, half-covered edge pixels (anti-aliasing); blown up,
 * those turn into the blurry blocks seen around the letters. Rendering the text at a higher
 * `resolution` doesn't help, because it still ends up in the same 384 × 216 canvas.
 *
 * The fix is a real pixel font used at its design size: Silkscreen (SIL Open Font License, from
 * @fontsource/silkscreen) is drawn on a grid where 8 px font size = exactly 1 font pixel per
 * canvas pixel. Every edge then lands on a whole pixel, there's nothing to blur, and the letters
 * scale up as clean blocks, like the rest of the art. Positions must be whole pixels too (the
 * scene rounds them), or the letters land between pixels and blur again.
 *
 * Silkscreen only has basic Latin letters, so in-game text sticks to ASCII: "<" ">" "^" "v"
 * instead of arrows, "[E]" instead of "· E".
 */
import type Phaser from "phaser";

/** The in-game pixel font. main.ts waits for it to load before the game starts. */
export const PIXEL_FONT = "Silkscreen";
/** Its design size: 1 font pixel = 1 canvas pixel. Use only this size (or 16, 24, …). */
export const PIXEL_FONT_SIZE = "8px";

/** The game's palette, for text (same colours as the page's CSS in index.html). */
export const INK = { night: "#0b0e16", parchment: "#ddd7c6", amber: "#f0a24a" } as const;

/**
 * A Phaser text style in the pixel font: `color` letters on a solid `background` box with a
 * 2-pixel margin. Solid colours only: a see-through box would mix with the night tint unevenly.
 */
export function pixelTextStyle(
  color: string,
  background: string,
): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    fontFamily: PIXEL_FONT,
    fontSize: PIXEL_FONT_SIZE,
    color,
    backgroundColor: background,
    padding: { x: 2, y: 2 },
    resolution: 1, // one texture pixel per canvas pixel: no in-between pixels to blur
  };
}

/**
 * Puts a text's bottom-centre at (x, y) with its top-left corner on a whole pixel. (Origin 0.5
 * would put a text 37 pixels wide at x − 18.5: half a pixel off, and blurry. So texts use origin
 * (0, 1) and this does the centring with rounding.) Returns the text, for chaining.
 */
export function placeCentred(
  text: Phaser.GameObjects.Text,
  x: number,
  y: number,
): Phaser.GameObjects.Text {
  return text.setPosition(Math.round(x - text.width / 2), Math.round(y));
}
