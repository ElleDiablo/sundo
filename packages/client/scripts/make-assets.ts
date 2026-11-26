/**
 * Generates Sundo's art and starter map in the style of the art direction prototype.
 *
 *   npm run assets -w @sundo/client            (refuses to overwrite a hand-edited map)
 *   npm run assets -w @sundo/client -- --force (regenerates the map too)
 *
 * Writes into public/assets:
 *   tiles/barangay.png    the tileset: ground, path edges, decoration, and multi-tile objects
 *                          (bahay kubo, sari-sari store, kapilya, trees, bamboo, fence, lamp post, bench)
 *   sprites/tanod.png     my tanod (from my character sheet) as a 4-frame walk, one row per look:
 *                          4 hats × 6 shirt colours (src/looks.ts), placeholder hats generated here
 *   sprites/kids.png      the 5 lost children (from my modern character sheet), 4-frame walk each
 *   sprites/glow.png      a soft warm glow, drawn additively over lit doorways and windows
 *   sprites/tikbalang.png the tikbalang (from my modern character sheet), 24 × 32 frames, 4-frame walk
 *   sprites/tikbalang-eye.png  only its eye, same frames: drawn above the darkness (S3-02)
 *   sprites/light.png     a round light (white, alpha in 4 steps), cut out of the darkness (S3-01)
 *   sprites/cone.png      the flashlight's 35°-each-side, 5-tile cone, pointing right (S3-01)
 *   maps/barangay.tmj     a 48×32 Tiled map using the tileset
 *
 * Layers (drawn bottom to top; the player sits between objects and above):
 *   ground   grass, paths, water, dikes, plaza          decor    tufts, flowers, pebbles, leaves
 *   objects  walls, stilts, trunks, stalk bases, fences  above    roofs, canopies, bamboo tops
 *   lights   point objects where a warm glow is drawn     spawns   the "player" point, 12
 *                                                                  "kid" hiding spots (S2-02), and
 *                                                                  5 "home" doorways (S2-04)
 *   zones    "safe" rectangles (S3-01): the kapilya plaza and the sari-sari store, lit and safe
 * A tile blocks movement if its tileset entry has `collides = true` (read by the engine).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { HATS, lookRow, SHIRTS, WALK_FRAMES } from "../src/looks.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "assets");
const force = process.argv.includes("--force");

// ─── Image buffer + PNG writer ───────────────────────────────────────────────────────────────
type RGB = readonly [number, number, number];
class Img {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray;
  // (Plain fields, not constructor shorthand: Node's built-in TypeScript support can't run that.)
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  set(x: number, y: number, c: RGB, a = 255): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }
  get(x: number, y: number): [number, number, number, number] {
    const i = (y * this.w + x) * 4;
    return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
  }
  /** Multiplies existing opaque pixels by k (soft shadows). */
  darken(x: number, y: number, k: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (Math.floor(y) * this.w + Math.floor(x)) * 4;
    for (let c = 0; c < 3; c++) this.data[i + c] = this.data[i + c]! * k;
  }
  blit(src: Img, dx: number, dy: number): void {
    for (let y = 0; y < src.h; y++)
      for (let x = 0; x < src.w; x++) {
        const p = src.get(x, y);
        if (p[3] > 0) this.set(dx + x, dy + y, [p[0], p[1], p[2]], p[3]);
      }
  }
  png(): Buffer {
    const raw = Buffer.alloc((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 4 + 1)] = 0;
      raw.set(this.data.subarray(y * this.w * 4, (y + 1) * this.w * 4), y * (this.w * 4 + 1) + 1);
    }
    const chunk = (type: string, body: Buffer) => {
      const b = Buffer.alloc(12 + body.length);
      b.writeUInt32BE(body.length, 0);
      b.write(type, 4, "ascii");
      body.copy(b, 8);
      b.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), body])), 8 + body.length);
      return b;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}
const C = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
/** Deterministic pixel noise in [0, 1). */
const hash = (x: number, y: number, s = 0) => {
  let h = Math.imul(x + s * 131, 374761393) ^ Math.imul(y + s * 977, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const pick = <T>(arr: readonly T[], r: number): T =>
  arr[Math.min(arr.length - 1, Math.floor(r * arr.length))]!;
/** Seeded RNG (same mulberry32 as the engine). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Palette (from the prototype)
const GRASS = ["#24391f", "#2a4224", "#2f4a29", "#355230"].map(C);
const DIRT = ["#6b5236", "#5e4730", "#78603f", "#644c33"].map(C);
const GROVE = ["#1b2a19", "#1f301c", "#182516"].map(C);
const WATER = ["#173040", "#1b3748", "#16303e"].map(C);
const CANOPY = ["#1e2e1d", "#2a5428", "#2a5428", "#46561c", "#576e19"].map(C);

// ─── Tileset ─────────────────────────────────────────────────────────────────────────────────
const COLS = 16;
const ROWS = 14;
const sheet = new Img(COLS * 16, ROWS * 16);
const collides = new Set<number>(); // tile ids that block movement
const names = new Map<number, string>();
const id = (col: number, row: number) => row * COLS + col;
function tile(
  col: number,
  row: number,
  name: string,
  solid: boolean,
  draw: (x: number, y: number) => RGB | null,
): number {
  const t = id(col, row);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const c = draw(x, y);
      if (c) sheet.set(col * 16 + x, row * 16 + y, c);
    }
  if (solid) collides.add(t);
  names.set(t, name);
  return t;
}
/** Places a multi-tile object image into the sheet; returns the tile ids as [row][col]. */
function block(
  col: number,
  row: number,
  img: Img,
  name: string,
  solid: (r: number, c: number) => boolean,
): number[][] {
  sheet.blit(img, col * 16, row * 16);
  const ids: number[][] = [];
  for (let r = 0; r < img.h / 16; r++) {
    ids.push([]);
    for (let c = 0; c < img.w / 16; c++) {
      const t = id(col + c, row + r);
      ids[r]!.push(t);
      names.set(t, `${name}-${r}-${c}`);
      if (solid(r, c)) collides.add(t);
    }
  }
  return ids;
}

// Row 0: ground
const grass = [0, 1, 2, 3].map((v) =>
  tile(v, 0, `grass-${v}`, false, (x, y) => {
    const r = hash(x + v * 16, y, 1);
    return r < 0.4 ? GRASS[1]! : r < 0.75 ? GRASS[2]! : r < 0.93 ? GRASS[0]! : GRASS[3]!;
  }),
);
const plaza = [6, 7].map((v) =>
  tile(v, 0, `plaza-${v}`, false, (x, y) => {
    if (x === 0 || y === 0 || (v === 7 && x === 8)) return C("#5a5a52");
    return hash(x + v * 16, y, 2) < 0.7 ? C("#7a7a6e") : C("#6e6e62");
  }),
);
const dike = tile(8, 0, "dike", false, (x, y) =>
  y === 0 || y === 15 ? C("#3f3120") : pick([C("#4a3a26"), C("#544430")], hash(x, y, 3)),
);
const paddy = [9, 10].map((v) =>
  tile(v, 0, `paddy-${v}`, true, (x, y) => {
    if (x % 5 === 1 && (y === 6 || y === 13)) return C("#4f7a3a");
    if (x % 5 === 1 && (y === 5 || y === 12)) return C("#6a9a48");
    return hash(x + v * 16, y, 4) < 0.015 ? C("#3d6a80") : pick(WATER, hash(x + v * 16, y, 5));
  }),
);
const creek = [11, 12].map((v) =>
  tile(v, 0, `creek-${v}`, true, (x, y) =>
    (x + y * 2 + v) % 9 === 0 ? C("#3d6a80") : pick(WATER, hash(x + v * 16, y, 6)),
  ),
);
const bridge = tile(13, 0, "bridge", false, (x, y) =>
  y % 4 === 0 ? C("#4a3320") : x === 0 || x === 15 ? C("#3e2f17") : C("#7a5530"),
);
const grove = [14, 15].map((v) =>
  tile(v, 0, `grove-${v}`, false, (x, y) => pick(GROVE, hash(x + v * 16, y, 7))),
);

// Row 1: paths with ragged grass edges. Bit set = that side borders grass (N=1, E=2, S=4, W=8).
const pathTiles: number[] = [];
for (let mask = 0; mask < 16; mask++) {
  pathTiles.push(
    tile(mask, 1, `path-${mask}`, false, (x, y) => {
      const d = Math.min(
        mask & 1 ? y : 99,
        mask & 2 ? 15 - x : 99,
        mask & 4 ? 15 - y : 99,
        mask & 8 ? x : 99,
      );
      const edge = d < 3 && hash(x + mask * 16, y, 8) < (3 - d) / 3 + 0.1;
      if (edge) return pick(GRASS, hash(x, y + mask * 16, 9));
      return pick(DIRT, hash(x + mask * 16, y, 10));
    }),
  );
}

// Row 2: decoration (transparent) and small objects
const decor = {
  tufts: [0, 1, 2].map((v) =>
    tile(v, 2, `tuft-${v}`, false, (x, y) => {
      const r = rng(v + 40);
      for (let k = 0; k < 2 + v; k++) {
        const cx = 3 + Math.floor(r() * 10),
          cy = 5 + Math.floor(r() * 9);
        if (
          (x === cx && (y === cy || y === cy - 1 || y === cy - 2)) ||
          ((x === cx - 1 || x === cx + 1) && y === cy - 1)
        )
          return y === cy - 2 ? C("#5a7a44") : C("#46663a");
      }
      return null;
    }),
  ),
  flowers: [
    ["#e8e0c8", "#fff6dc"],
    ["#c8483a", "#e0644a"],
    ["#d8b048", "#f0cc66"],
  ].map(([a, b], v) =>
    tile(3 + v, 2, `flowers-${v}`, false, (x, y) => {
      const spots = [
        [4, 6],
        [9, 4],
        [7, 10],
        [12, 9],
        [3, 12],
      ];
      for (const [fx, fy] of spots) {
        if (x === fx && y === fy) return C(a!);
        if (x === fx! + 1 && y === fy) return C(b!);
        if (x === fx && y === fy! + 1) return C("#3f5d34");
      }
      return null;
    }),
  ),
  pebbles: [0, 1].map((v) =>
    tile(6 + v, 2, `pebbles-${v}`, false, (x, y) => {
      const spots = v
        ? [
            [5, 5],
            [10, 11],
          ]
        : [
            [3, 9],
            [8, 4],
            [12, 12],
          ];
      for (const [px, py] of spots) {
        if ((x === px || x === px! + 1) && y === py) return C("#8a8476");
        if ((x === px || x === px! + 1) && y === py! + 1) return C("#5e5a50");
      }
      return null;
    }),
  ),
  leaves: [0, 1].map((v) =>
    tile(8 + v, 2, `leaves-${v}`, false, (x, y) =>
      hash(x, y, 11 + v) > 0.93
        ? pick(["#6b5a30", "#7a5a2a", "#5a4a26"].map(C), hash(y, x, 12))
        : null,
    ),
  ),
  puddle: tile(10, 2, "puddle", false, (x, y) => {
    const d = ((x - 7.5) / 6) ** 2 + ((y - 9) / 3) ** 2;
    if (d > 1) return null;
    return y < 8 && x > 5 && x < 10 ? C("#3d6a80") : C("#2a4a5a");
  }),
};
const fence = tile(11, 2, "fence", true, (x, y) => {
  if (x === 4 || x === 5 || x === 14 || x === 15)
    return y >= 3 ? C(x % 2 ? "#6c4c34" : "#8b7e5b") : null;
  if (y === 6 || y === 11) return C("#aa9b69");
  if (y === 7 || y === 12) return C("#8b7e5b");
  return null;
});

// Multi-tile objects (drawn at full size, then sliced into 16 px tiles)
function kuboImage(): Img {
  const im = new Img(112, 96);
  const x0 = 8,
    base = 95,
    w = 96;
  const wallTop = base - 46,
    wallBot = base - 16;
  for (const sx of [3, 30, 62, 92])
    for (let y = wallBot; y <= base; y++) {
      im.set(x0 + sx, y, C("#6c4c34"));
      im.set(x0 + sx + 1, y, C("#4e412c"));
    }
  for (let y = wallTop; y <= wallBot; y++)
    for (let x = x0; x <= x0 + w; x++) {
      const s = (x - x0) % 3;
      let c = s === 0 ? "#aa9b69" : s === 1 ? "#c3b581" : "#beae6d";
      if ((y - wallTop) % 10 === 0) c = "#8b7e5b";
      im.set(x, y, C(c));
    }
  for (let x = x0 - 2; x <= x0 + w + 2; x++) {
    im.set(x, wallBot + 1, C("#4e412c"));
    im.set(x, wallBot + 2, C("#342b1e"));
  }
  // window with a candle behind it
  const wx = x0 + 16,
    wy = wallTop + 8;
  for (let y = wy; y < wy + 14; y++)
    for (let x = wx; x < wx + 20; x++) {
      const edge = y === wy || y === wy + 13 || x === wx || x === wx + 19,
        bar = x === wx + 10 || y === wy + 7;
      if (edge || bar) im.set(x, y, C("#6c4c34"));
      else {
        const g = Math.max(0, 1 - Math.hypot(x - (wx + 10), y - (wy + 9)) / 11);
        im.set(x, y, [Math.round(60 + 170 * g), Math.round(32 + 100 * g), Math.round(14 + 30 * g)]);
      }
    }
  // doorway (exactly tile column 4), lit from inside
  const dx = 64,
    dw = 16;
  for (let y = wallTop + 4; y <= wallBot; y++)
    for (let x = dx; x < dx + dw; x++) {
      if (x === dx || x === dx + dw - 1 || y === wallTop + 4) im.set(x, y, C("#342b1e"));
      else {
        const k = Math.max(0.35, 1 - Math.hypot((x - dx - 8) / 8, (y - wallBot + 8) / 14) * 0.6);
        im.set(x, y, [Math.round(240 * k), Math.round(150 * k), Math.round(60 * k)]);
      }
    }
  for (let y = wallBot + 1; y <= base; y++) {
    im.set(dx + 2, y, C("#8b7e5b"));
    im.set(dx + dw - 3, y, C("#8b7e5b"));
    if ((y - wallBot) % 4 === 0)
      for (let x = dx + 3; x < dx + dw - 3; x++) im.set(x, y, C("#aa9b69"));
  }
  // thatch roof
  const rTop = wallTop - 38,
    rBot = wallTop + 3,
    cx = x0 + w / 2;
  for (let y = rTop; y <= rBot; y++) {
    const t = (y - rTop) / (rBot - rTop),
      half = 22 + t * 33;
    for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
      const straw = hash(x, y >> 1, 11);
      let c =
        (y - rTop) % 5 === 0
          ? "#8b7e5b"
          : straw > 0.72
            ? "#c3b581"
            : straw > 0.32
              ? "#aa9b69"
              : "#beae6d";
      if (Math.abs(x - cx) > half - 3) c = "#8b7e5b";
      if (y >= rBot - 1 && hash(x, 0, 12) > 0.5) c = "#7d6244";
      im.set(x, y, C(c));
    }
  }
  for (let x = cx - 20; x <= cx + 20; x++) {
    im.set(x, rTop, C("#6c4c34"));
    im.set(x, rTop - 1, C("#7d6244"));
  }
  return im;
}

function storeImage(): Img {
  const im = new Img(112, 80);
  const x0 = 6,
    w = 100,
    base = 79,
    top = base - 54;
  for (let y = top; y <= base; y++)
    for (let x = x0; x <= x0 + w; x++) {
      let c = hash(x >> 2, y >> 2, 21) > 0.8 ? "#a1a4a1" : "#bdc7cf";
      if (y > base - 10) c = hash(x >> 1, y >> 1, 22) > 0.5 ? "#788480" : "#6d7c75";
      if (hash(x, y, 23) > 0.99) c = "#576361";
      im.set(x, y, C(c));
    }
  const mx = x0 + 10,
    my = top + 12,
    mw = 58,
    mh = 26;
  for (let y = my; y < my + mh; y++)
    for (let x = mx; x < mx + mw; x++) {
      const edge = y === my || y === my + mh - 1 || x === mx || x === mx + mw - 1;
      const mesh = (x - mx) % 3 === 0 || (y - my) % 3 === 0;
      const g = Math.max(0, 1 - Math.hypot(x - (mx + 42), y - (my + 18)) / 24);
      let c: RGB = [Math.round(45 + 150 * g), Math.round(35 + 100 * g), Math.round(29 + 35 * g)];
      if (y === my + 9 || y === my + 18) c = C("#4e412c");
      else if (
        !mesh &&
        ((y > my + 2 && y < my + 9) || (y > my + 10 && y < my + 18)) &&
        hash(x, y >> 2, 24) > 0.5
      )
        c = pick(
          ["#c04035", "#ffd26d", "#216dac", "#f0855e", "#e4dbcc"].map(C),
          hash(x >> 1, y, 25),
        );
      if (mesh) c = C("#424947");
      if (edge) c = C("#576361");
      im.set(x, y, c);
    }
  im.set(mx + 42, my + 17, C("#ffdc77"));
  im.set(mx + 42, my + 16, C("#f8eca9"));
  for (let y = top + 18; y <= base; y++)
    for (let x = x0 + 78; x < x0 + 92; x++)
      im.set(x, y, C(x === x0 + 78 ? "#342b1e" : (x - x0) % 4 === 0 ? "#4e412c" : "#6c4c34"));
  const rTop = top - 20;
  for (let y = rTop; y <= top + 1; y++)
    for (let x = 0; x < 112; x++) {
      const ridge = x % 4;
      let c = ridge === 0 ? "#424947" : ridge === 1 ? "#788480" : "#576361";
      if (hash(x >> 1, y >> 1, 26) > 0.9) c = "#7a4636";
      if (y === top + 1) c = "#293125";
      im.set(x, y, C(c));
    }
  const sx = 24,
    sy = rTop + 4;
  for (let y = sy; y < sy + 10; y++)
    for (let x = sx; x < sx + 64; x++)
      im.set(
        x,
        y,
        C(y === sy || y === sy + 9 || x === sx || x === sx + 63 ? "#5c2f30" : "#f0e0d1"),
      );
  for (let i = 0; i < 58; i++)
    if (hash(i >> 1, 0, 30) > 0.35 && i % 6 !== 5) {
      im.set(sx + 3 + i, sy + 4, C("#c04035"));
      im.set(sx + 3 + i, sy + 5, C("#a74b43"));
    }
  return im;
}

function kapilyaImage(): Img {
  const im = new Img(96, 80);
  const base = 79,
    top = 34;
  for (let y = top; y <= base; y++)
    for (let x = 6; x < 90; x++) {
      let c = hash(x >> 2, y >> 2, 31) > 0.85 ? "#dacca3" : "#e4dbcc";
      if (y > base - 8) c = "#a6a68d";
      im.set(x, y, C(c));
    }
  // arched doorway, candle-lit (tile columns 2–3)
  for (let y = 50; y <= base; y++)
    for (let x = 36; x < 60; x++) {
      const arch = y < 58 && Math.hypot(x - 47.5, y - 58) > 12;
      if (arch) continue;
      const k = Math.max(0.35, 1 - Math.hypot((x - 48) / 12, (y - 68) / 16) * 0.6);
      im.set(
        x,
        y,
        x === 36 || x === 59
          ? C("#7c5b54")
          : [Math.round(240 * k), Math.round(165 * k), Math.round(70 * k)],
      );
    }
  for (const wx of [16, 70])
    for (let y = 44; y < 58; y++)
      for (let x = wx; x < wx + 9; x++)
        im.set(x, y, y === 44 || x === wx || x === wx + 8 ? C("#7c5b54") : C("#6c9cd0"));
  // gable roof with a cross
  for (let y = 8; y <= top + 1; y++) {
    const half = 8 + (y - 8) * 1.55;
    for (let x = Math.round(48 - half); x <= Math.round(48 + half); x++)
      im.set(x, y, C(y === top + 1 ? "#5c2f30" : (x + y) % 4 === 0 ? "#7a4636" : "#a74b43"));
  }
  for (let y = 0; y < 10; y++) {
    im.set(48, y, C("#e4dbcc"));
    im.set(47, y, C("#bfb38a"));
  }
  for (let x = 44; x < 52; x++) im.set(x, 3, C("#e4dbcc"));
  return im;
}

function treeImage(seed: number): Img {
  const im = new Img(48, 64);
  const cx = 24,
    base = 62,
    r = 21;
  for (let x = 12; x < 38; x++) for (const y of [62, 63]) im.set(x, y, C("#1b2a19"), 120);
  for (let y = base - 16; y <= base; y++)
    for (let x = cx - 2; x <= cx + 2; x++)
      im.set(x, y, C(x === cx - 2 ? "#4e412c" : x === cx + 2 ? "#342b1e" : "#6c4c34"));
  const cy = 24;
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++) {
      const lumpy = r * (0.86 + 0.14 * Math.sin(Math.atan2(y, x) * 6 + seed));
      if (Math.hypot(x, y) > lumpy) continue;
      const shade =
        0.55 -
        (y / lumpy) * 0.28 -
        (x / lumpy) * 0.12 +
        (hash((x + cx) >> 1, (y + cy) >> 1, seed) - 0.5) * 0.3;
      im.set(cx + x, cy + y, CANOPY[Math.max(0, Math.min(4, Math.floor(shade * 5)))]!);
    }
  return im;
}

function bambooImage(seed: number): Img {
  const im = new Img(16, 48);
  const r = rng(seed);
  const stalks = [
    { x: 4, top: 2 + Math.floor(r() * 6) },
    { x: 10, top: 10 + Math.floor(r() * 8) },
  ];
  for (const s of stalks) {
    for (let y = s.top; y < 48; y++) {
      const node = (47 - y) % 11 === 0;
      im.set(s.x, y, C(node ? "#2c451d" : "#6a9a48"));
      im.set(s.x + 1, y, C(node ? "#2c451d" : "#5f8a3e"));
      im.set(s.x + 2, y, C(node ? "#2c451d" : "#3f6128"));
    }
    for (let l = 0; l < 6; l++) {
      const ly = s.top + Math.floor(r() * 22),
        dir = r() > 0.5 ? 1 : -1;
      for (let t = 0; t < 6; t++)
        im.set(
          s.x + 1 + dir * t,
          ly + (t >> 1),
          C(t > 3 ? "#284620" : t > 1 ? "#2e5226" : "#3c6a2e"),
        );
    }
  }
  for (let x = 2; x < 15; x++) im.set(x, 47, C("#182516"), 140);
  return im;
}

function lampImage(): Img {
  const im = new Img(16, 64);
  for (let y = 6; y < 64; y++)
    for (let x = 6; x < 9; x++) im.set(x, y, C(x === 8 ? "#2a2c34" : "#3a3c44"));
  for (let x = 6; x < 16; x++) {
    im.set(x, 6, C("#3a3c44"));
    im.set(x, 7, C("#3a3c44"));
  }
  for (let x = 11; x < 16; x++) for (let y = 8; y < 11; y++) im.set(x, y, C("#55606a"));
  return im;
}

function benchImage(): Img {
  const im = new Img(32, 16);
  for (let x = 2; x < 30; x++) {
    im.set(x, 8, C("#8b7e5b"));
    im.set(x, 9, C("#6c4c34"));
  }
  for (const lx of [3, 28]) for (let y = 10; y < 14; y++) im.set(lx, y, C("#4e412c"));
  return im;
}

// Rows 3–8: kubo (7×6) and store (7×5); bamboo and lamp beside them
const KUBO = block(0, 3, kuboImage(), "kubo", (r, c) => r >= 3 && !(r === 5 && c === 4));
const STORE = block(7, 3, storeImage(), "store", (r) => r >= 2);
const BAMBOO = [
  block(14, 3, bambooImage(1), "bamboo-a", (r) => r === 2),
  block(15, 3, bambooImage(2), "bamboo-b", (r) => r === 2),
];
const LAMP = block(14, 6, lampImage(), "lamp", (r) => r === 3);
const BENCH = block(7, 8, benchImage(), "bench", () => true);
// Rows 9–13: kapilya (6×5) and two trees (3×4)
const KAPILYA = block(0, 9, kapilyaImage(), "kapilya", (r) => r >= 2);
const TREES = [
  block(6, 9, treeImage(4), "tree-a", (r, c) => r === 3 && c === 1),
  block(9, 9, treeImage(7), "tree-b", (r, c) => r === 3 && c === 1),
];

// ─── Map: 48 × 32 ────────────────────────────────────────────────────────────────────────────
const W = 48,
  H = 32;
type Layer = number[]; // tile ids + 1 (gid), 0 = empty
const layer = (): Layer => new Array<number>(W * H).fill(0);
const L = { ground: layer(), decor: layer(), objects: layer(), above: layer() };
const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
const put = (l: Layer, x: number, y: number, t: number) => {
  if (inside(x, y)) l[y * W + x] = t + 1;
};
const getT = (l: Layer, x: number, y: number) => (inside(x, y) ? l[y * W + x]! - 1 : -1);
const fill = (x0: number, y0: number, w: number, h: number, fn: (x: number, y: number) => void) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) fn(x, y);
};
const lights: { x: number; y: number; name: string }[] = [];
/** Stamps a multi-tile object: rows listed in `aboveRows` go on the "above" layer. */
function stamp(ids: number[][], x0: number, y0: number, aboveRows: number) {
  ids.forEach((row, r) =>
    row.forEach((t, c) => {
      let any = false;
      for (let y = 0; y < 16 && !any; y++)
        for (let x = 0; x < 16 && !any; x++)
          if (sheet.get((t % COLS) * 16 + x, Math.floor(t / COLS) * 16 + y)[3] > 0) any = true;
      if (!any && !collides.has(t)) return; // fully transparent, non-blocking: leave empty
      put(r < aboveRows ? L.above : L.objects, x0 + c, y0 + r, t);
    }),
  );
}

// Ground: grass everywhere, varied
fill(0, 0, W, H, (x, y) => put(L.ground, x, y, pick(grass, hash(x, y, 50))));
// Paths (marked first, edges resolved at the end)
const isPath = new Array<boolean>(W * H).fill(false);
const path = (x0: number, y0: number, w: number, h: number) =>
  fill(x0, y0, w, h, (x, y) => inside(x, y) && (isPath[y * W + x] = true));
path(1, 17, W - 2, 2); // main road
path(22, 11, 2, 6); // plaza → road
// Creek (cols 17–18) with two crossings
fill(17, 0, 2, H, (x, y) => put(L.ground, x, y, pick(creek, hash(x, y, 51))));
// Kapilya plaza
fill(19, 7, 9, 4, (x, y) => put(L.ground, x, y, pick(plaza, hash(x, y, 52))));
// Bamboo grove floor (bottom left) and paddies (bottom right)
fill(1, 21, 15, 10, (x, y) => put(L.ground, x, y, pick(grove, hash(x, y, 53))));
fill(31, 21, 16, 10, (x, y) =>
  put(
    L.ground,
    x,
    y,
    (y - 21) % 3 === 0 || (x - 31) % 4 === 0 ? dike : pick(paddy, hash(x, y, 54)),
  ),
);
fill(31, 20, 16, 1, (x, y) => x !== 35 && x !== 36 && put(L.objects, x, y, fence));
path(35, 19, 2, 1);
// Grove: a trail to the plank bridge, stalks either side
path(1, 27, 16, 1);
{
  const r = rng(77);
  fill(1, 21, 15, 10, (x, y) => {
    if (y >= 26 && y <= 28) return; // keep the trail clear (stalks are 3 tall)
    if (r() < 0.42) stamp(pick(BAMBOO, r()), x, y - 2, 2);
  });
}
// Buildings: [x, y] is the top-left tile. Kubo door/ladder is column 4 of 7.
// The order matters (S2-04): child k0 (Tala) lives in the first house, k1 in the second, and so on.
const houses: [number, number][] = [
  [3, 2],
  [32, 2],
  [9, 9],
  [40, 9],
  [21, 21],
];
for (const [x, y] of houses) {
  stamp(KUBO, x, y, 3);
  if (y < 17)
    path(x + 4, y + 6, 1, 17 - (y + 6)); // north of the road: straight down to it
  else {
    // south of the road: the door faces away, so the path goes round the west side
    path(x - 1, 19, 1, y + 7 - 19);
    path(x - 1, y + 6, 6, 1);
  }
  lights.push(
    { x: (x + 4) * 16 + 8, y: (y + 4) * 16 + 8, name: "doorway" },
    { x: x * 16 + 34, y: y * 16 + 64, name: "window" },
  );
}
stamp(KAPILYA, 20, 2, 2);
lights.push({ x: 22 * 16 + 16, y: 2 * 16 + 68, name: "kapilya" });
stamp(STORE, 29, 9, 2);
path(34, 14, 1, 3);
stamp(BENCH, 29, 14, 0);
lights.push({ x: 29 * 16 + 58, y: 9 * 16 + 54, name: "store" });
stamp(LAMP, 27, 13, 3);
// Bridges over the creek
fill(17, 17, 2, 2, (x, y) => put(L.ground, x, y, bridge));
fill(17, 27, 2, 1, (x, y) => put(L.ground, x, y, bridge));
// Trees: along the top and bottom edges and a few in the open
for (const [x, y] of [
  [-1, -2],
  [12, -2],
  [27, -1],
  [44, -2],
  [14, 3],
  [28, 4],
  [44, 3],
  [0, 12],
  [37, 12],
  [24, 12],
  [28, 23],
  [19, 27],
] as const)
  stamp(pick(TREES, hash(x, y, 60)), x, y, 3);

// Resolve paths into edge tiles (skip cells covered by water/bridge)
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    if (!isPath[y * W + x]) continue;
    const g = getT(L.ground, x, y);
    if (creek.includes(g) || g === bridge) continue;
    const open = (dx: number, dy: number) => {
      const nx = x + dx,
        ny = y + dy;
      if (!inside(nx, ny)) return false;
      const t = getT(L.ground, nx, ny);
      return !isPath[ny * W + nx] && !creek.includes(t) && t !== bridge && !plaza.includes(t);
    };
    const mask =
      (open(0, -1) ? 1 : 0) | (open(1, 0) ? 2 : 0) | (open(0, 1) ? 4 : 0) | (open(-1, 0) ? 8 : 0);
    put(L.ground, x, y, pathTiles[mask]!);
  }

// Procedural decoration (seeded): never on water, plaza or under objects; tufts thicker near edges
{
  const r = rng(2026);
  fill(0, 0, W, H, (x, y) => {
    const g = getT(L.ground, x, y);
    if (
      getT(L.objects, x, y) >= 0 ||
      creek.includes(g) ||
      paddy.includes(g) ||
      plaza.includes(g) ||
      g === bridge ||
      g === dike
    )
      return;
    if (pathTiles.includes(g)) {
      if (r() < 0.06) put(L.decor, x, y, pick(decor.pebbles, r()));
      else if (r() < 0.04) put(L.decor, x, y, decor.puddle);
      return;
    }
    const nearEdge = [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ].some(
      ([dx, dy]) =>
        pathTiles.includes(getT(L.ground, x + dx!, y + dy!)) ||
        getT(L.objects, x + dx!, y + dy!) >= 0,
    );
    const v = r();
    if (v < (nearEdge ? 0.35 : 0.12)) put(L.decor, x, y, pick(decor.tufts, r()));
    else if (v < (nearEdge ? 0.4 : 0.16) && hash(x >> 2, y >> 2, 70) > 0.6)
      put(L.decor, x, y, pick(decor.flowers, hash(x >> 2, y >> 2, 71)));
    else if (v < 0.19) put(L.decor, x, y, pick(decor.pebbles, r()));
  });
  // leaves under trees
  fill(0, 0, W, H, (x, y) => {
    if (TREES.some((t) => t[3]![1] === getT(L.objects, x, y)))
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, 1],
        [-1, 1],
        [1, 1],
      ])
        if (
          getT(L.objects, x + dx!, y + dy!) < 0 &&
          r() < 0.5 &&
          !paddy.includes(getT(L.ground, x + dx!, y + dy!))
        )
          put(L.decor, x + dx!, y + dy!, pick(decor.leaves, r()));
  });
}

// Hiding spots for the lost children (S2-02), as [tile x, tile y]. src/barangay.test.ts reads
// the generated map and checks that each one is walkable and can be reached from the plaza.
const KID_SPOTS: [number, number][] = [
  [2, 2], // top-left corner
  [12, 9], // field west of the plaza, behind the first kubo
  [11, 15], // behind the kubo south of the road
  [45, 2], // top-right corner
  [41, 9], // field east of the store
  [26, 15], // by the tree south of the plaza
  [3, 24], // bamboo grove, west
  [11, 26], // bamboo grove, middle
  [6, 31], // bottom-left, south of the grove
  [23, 29], // south field
  [35, 24], // on a paddy dike
  [47, 22], // east edge, past the paddies
];

// The tikbalang's points (S3-02), as [tile x, tile y]. src/barangay.test.ts checks each one is
// open, reachable and outside the safe zones.
const TIK_SPAWN: [number, number] = [8, 27]; // the bamboo grove trail: its home
const PATROL: [number, number][] = [
  [5, 17], // the road, west
  [15, 18], // the road by the creek bridge
  [30, 18], // the road, east of the plaza path
  [44, 17], // the road, far east
  [4, 27], // the grove trail, west
  [13, 27], // the grove trail, east
  [23, 29], // the south field
  [35, 24], // a paddy dike
  [12, 9], // the field west of the plaza
  [41, 9], // the field east of the store
];
const AMBUSH: [number, number][] = [
  [16, 17], // the west end of the road bridge: everyone crosses here
  [19, 27], // the east end of the grove bridge
  [35, 21], // a dike junction in the paddies
  [8, 27], // deep in the grove
];
// Where a caught player wakes up, lost (S3-03): along the bamboo grove's trail and its edge.
const NALIGAW_SPOTS: [number, number][] = [
  [2, 27],
  [5, 27],
  [11, 27],
  [15, 27],
  [3, 24],
];

// Safe zones (S3-01), as [tile x, tile y, width, height]: candle-lit, batteries recharge, and the
// tikbalang can't go in (S3-02). The plaza is the 9 × 4 stone square; the store zone covers the
// store and the ground in front of it, down to (not including) the road.
const SAFE_ZONES: [number, number, number, number][] = [
  [19, 7, 9, 4], // kapilya plaza
  [28, 9, 9, 7], // sari-sari store and its front
];

const tmj = {
  type: "map",
  version: "1.10",
  tiledversion: "1.12.2",
  orientation: "orthogonal",
  renderorder: "right-down",
  infinite: false,
  compressionlevel: -1,
  width: W,
  height: H,
  tilewidth: 16,
  tileheight: 16,
  nextlayerid: 8,
  // The id Tiled gives the next object drawn by hand: past every id used below (lights 2…,
  // kid spots 100…, homes 200…, safe zones 300…, tikbalang points 400…), so a hand-added object never clashes with a generated one.
  nextobjectid: 400 + 1 + PATROL.length + AMBUSH.length + NALIGAW_SPOTS.length,
  layers: [
    ...(["ground", "decor", "objects", "above"] as const).map((name, i) => ({
      id: i + 1,
      name,
      type: "tilelayer",
      width: W,
      height: H,
      x: 0,
      y: 0,
      opacity: 1,
      visible: true,
      data: L[name],
    })),
    {
      id: 5,
      name: "lights",
      type: "objectgroup",
      draworder: "topdown",
      x: 0,
      y: 0,
      opacity: 1,
      visible: true,
      objects: lights.map((l, i) => ({
        id: i + 2,
        name: l.name,
        type: "",
        point: true,
        x: l.x,
        y: l.y,
        width: 0,
        height: 0,
        rotation: 0,
        visible: true,
      })),
    },
    {
      id: 6,
      name: "spawns",
      type: "objectgroup",
      draworder: "topdown",
      x: 0,
      y: 0,
      opacity: 1,
      visible: true,
      objects: [
        {
          id: 1,
          name: "player",
          type: "",
          point: true,
          x: 23 * 16 + 8,
          y: 9 * 16 + 8,
          width: 0,
          height: 0,
          rotation: 0,
          visible: true,
        },
        // S2-04: each kubo's doorway, the one open tile in its bottom row (row 5, column 4: see
        // KUBO's `collides` rule). In the same order as `houses`, so the nth "home" point is
        // child k<n>'s house. Leading a child here takes them home.
        ...houses.map(([hx, hy], i) => ({
          id: 200 + i,
          name: "home",
          type: "",
          point: true,
          x: (hx + 4) * 16 + 8,
          y: (hy + 5) * 16 + 8,
          width: 0,
          height: 0,
          rotation: 0,
          visible: true,
        })),
        // S3-02: where the tikbalang appears, walks and lies in wait.
        ...[
          ["tikbalang", TIK_SPAWN] as const,
          ...PATROL.map((p) => ["patrol", p] as const),
          ...AMBUSH.map((p) => ["ambush", p] as const),
          ...NALIGAW_SPOTS.map((p) => ["grove", p] as const), // S3-03
        ].map(([name, [tx, ty]], i) => ({
          id: 400 + i,
          name,
          type: "",
          point: true,
          x: tx * 16 + 8,
          y: ty * 16 + 8,
          width: 0,
          height: 0,
          rotation: 0,
          visible: true,
        })),
        // S2-02: the 12 places a lost child can be hiding. Spread over the whole map, off the
        // main paths: corners, behind houses, the bamboo grove, a paddy dike, the south field.
        ...KID_SPOTS.map(([tx, ty], i) => ({
          id: 100 + i,
          name: "kid",
          type: "",
          point: true,
          x: tx * 16 + 8,
          y: ty * 16 + 8,
          width: 0,
          height: 0,
          rotation: 0,
          visible: true,
        })),
      ],
    },
    {
      id: 7,
      name: "zones",
      type: "objectgroup",
      draworder: "topdown",
      x: 0,
      y: 0,
      opacity: 1,
      visible: true,
      objects: SAFE_ZONES.map(([tx, ty, w, h], i) => ({
        id: 300 + i,
        name: "safe",
        type: "",
        x: tx * 16,
        y: ty * 16,
        width: w * 16,
        height: h * 16,
        rotation: 0,
        visible: true,
      })),
    },
  ],
  tilesets: [
    {
      firstgid: 1,
      name: "barangay",
      image: "../tiles/barangay.png",
      imagewidth: COLS * 16,
      imageheight: ROWS * 16,
      tilewidth: 16,
      tileheight: 16,
      tilecount: COLS * ROWS,
      columns: COLS,
      margin: 0,
      spacing: 0,
      tiles: [...names.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, name]) => ({
          id: t,
          type: name,
          properties: [{ name: "collides", type: "bool", value: collides.has(t) }],
        })),
    },
  ],
};

// ─── Tanod: my sprite + a generated 4-frame walk, in every hat and shirt ────────────────────
interface SpriteData {
  palette: Record<string, string>;
  rows: string[];
}
type Grid = (RGB | null)[][];
const tanodData = JSON.parse(
  readFileSync(join(here, "sprites", "tanod.json"), "utf8"),
) as SpriteData;
const FW = 16,
  FH = 28; // frame size (sprite is 14 × 26, padded)

// Looks (S2-01). My sheet's tanod wears a salakot (rows 0–4) and a gold shirt (rows 9–16).
// The top of the head starts on row 5: hair (q) either side of the face, with the salakot's brim
// ends (p, i, j) still poking out at the sides.
const HAT_ROWS = 5; // rows 0–4 are the salakot
const BRIM_ENDS = new Set(["p", "i", "j"]); // brim pixels on row 5, removed when the hat changes
const SHIRT_ROWS = [9, 16]; // first and last row of the shirt
const SHIRT_KEYS = new Set(["a", "l", "x", "y", "z", "m", "e", "f", "i"]); // its gold shades

// Placeholder hats, drawn over rows 0–5 of the 14-pixel-wide sprite. Letters are colours below;
// "." leaves the pixel as it is (row 5) or empty (rows 0–4). Salakot (hat 0) is my original.
const HAT_COLOURS: Record<string, string> = {
  q: "#403333", // hair, the same as my sheet's
  c: "#b8443a", // cap
  d: "#7a2b25", // cap brim (darker)
  b: "#3e5f9c", // bandana
  k: "#283f6b", // bandana knot (darker)
};
const HAT_PIXELS: Record<string, string[]> = {
  Cap: [
    "..............",
    "..............",
    "....cccc......",
    "...cccccc.....",
    "..ccccccccddd.",
    "..............",
  ],
  Bandana: [
    "..............",
    "..............",
    "..............",
    "...qqqqqq.....",
    ".kbbbbbbbb....",
    "k.............",
  ],
  "No hat": [
    "..............",
    "..............",
    "..............",
    "...qqqqqq.....",
    "..qqqqqqqq....",
    "..............",
  ],
};

/** My tanod as a grid of colours, with the given hat (by name) and shirt colour. */
function dressedGrid(s: SpriteData, hat: string, shirtHex: string): Grid {
  const base = C(s.palette["a"]!); // the shirt's main gold: its brightness = "no change"
  const target = C(shirtHex);
  const lum = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const pixels = HAT_PIXELS[hat];
  return s.rows.map((row, y) =>
    [...row].map((ch, x): RGB | null => {
      // Hat: replace the salakot rows, and remove its brim ends from the first head row.
      if (pixels && y <= HAT_ROWS) {
        const p = pixels[y]![x]!;
        if (p !== ".") return C(HAT_COLOURS[p]!);
        if (y < HAT_ROWS || BRIM_ENDS.has(ch)) return null;
      }
      if (ch === ".") return null;
      const colour = C(s.palette[ch]!);
      // Shirt: same light and shade as the gold, in the new colour. Gold itself stays exact.
      if (shirtHex !== SHIRTS[0].hex && y >= SHIRT_ROWS[0]! && y <= SHIRT_ROWS[1]!) {
        if (SHIRT_KEYS.has(ch)) {
          const k = lum(colour) / lum(base);
          return target.map((v) => Math.min(255, Math.round(v * k))) as unknown as RGB;
        }
      }
      return colour;
    }),
  );
}

/** A sprite from its letters and palette, as a grid of colours (no changes). */
function plainGrid(s: SpriteData): Grid {
  return s.rows.map((row) => [...row].map((ch) => (ch === "." ? null : C(s.palette[ch]!))));
}

function walkFrames(grid: Grid): Grid[] {
  const h = grid.length,
    legTop = Math.round(h * 0.76);
  const bottom = grid[h - 1]!.map((c, x) => (c ? x : -1)).filter((x) => x >= 0);
  const cx = bottom.reduce((a, b) => a + b, 0) / Math.max(1, bottom.length);
  const lift = (side: number) =>
    grid.map((row, y) =>
      row.map((c, x) =>
        y < legTop || !(side < 0 ? x < cx : x >= cx) ? c : (grid[y + 1]?.[x] ?? null),
      ),
    );
  const bob = grid.map((row, y) =>
    y >= legTop ? row : y > 0 ? grid[y - 1]! : row.map(() => null),
  );
  return [grid, lift(-1), bob, lift(1)];
}
const tanod = new Img(FW * WALK_FRAMES, FH * HATS.length * SHIRTS.length);
HATS.forEach((hat, h) =>
  SHIRTS.forEach((shirt, sh) => {
    const top = lookRow(h, sh) * FH; // this look's row in the sheet
    walkFrames(dressedGrid(tanodData, hat, shirt.hex)).forEach((f, i) => {
      const ox = i * FW + Math.floor((FW - f[0]!.length) / 2),
        oy = top + FH - f.length;
      f.forEach((row, y) => row.forEach((c, x) => c && tanod.set(ox + x, oy + y, c)));
    });
  }),
);

// The lost children (S2-02): one row per child (k0…k4, same order as kids.json), 4 walk frames.
const kidsData = JSON.parse(readFileSync(join(here, "sprites", "kids.json"), "utf8")) as {
  kids: (SpriteData & { name: string })[];
};
const kidsSheet = new Img(FW * WALK_FRAMES, FH * kidsData.kids.length);
kidsData.kids.forEach((kid, row) => {
  walkFrames(plainGrid(kid)).forEach((f, i) => {
    const ox = i * FW + Math.floor((FW - f[0]!.length) / 2),
      oy = row * FH + FH - f.length; // feet on the bottom of the frame, like the tanod
    f.forEach((r, y) => r.forEach((c, x) => c && kidsSheet.set(ox + x, oy + y, c)));
  });
});

// The tikbalang (S3-02): my sprite from the modern sheet, 4-frame walk in 24 × 32 frames, plus a
// sheet with ONLY its eye pixels, drawn above the darkness so the eye glints in the dark.
const tikData = JSON.parse(
  readFileSync(join(here, "sprites", "tikbalang.json"), "utf8"),
) as SpriteData & { eye: string };
const TW = 24,
  TH = 32;
const eyeRGB = C(tikData.palette[tikData.eye]!);
const tikSheet = new Img(TW * WALK_FRAMES, TH);
const eyeSheet = new Img(TW * WALK_FRAMES, TH);
walkFrames(plainGrid(tikData)).forEach((f, i) => {
  const ox = i * TW + Math.floor((TW - f[0]!.length) / 2),
    oy = TH - f.length; // feet on the bottom of the frame
  f.forEach((r, y) =>
    r.forEach((c, x) => {
      if (!c) return;
      tikSheet.set(ox + x, oy + y, c);
      if (c.every((v, k) => v === eyeRGB[k])) eyeSheet.set(ox + x, oy + y, [255, 244, 160]);
    }),
  );
});

// Warm glow for lit doorways and windows (drawn with additive blending)
const glow = new Img(64, 64);
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) {
    const d = Math.hypot(x - 31.5, y - 31.5) / 32;
    if (d >= 1) continue;
    const k = (1 - d) ** 2;
    glow.set(x, y, [Math.round(255 * k), Math.round(150 * k), Math.round(60 * k)], 255);
  }

// Lights cut out of the darkness (S3-01). White, with the strength in the alpha channel. The
// strength falls off in 4 hard steps instead of a smooth gradient: banded light is the "lit pixel
// art" look (GDD §9), and it stays crisp when the canvas is scaled up.
const band = (k: number) => (k > 0.75 ? 255 : k > 0.5 ? 205 : k > 0.25 ? 140 : k > 0 ? 70 : 0);
const WHITE: RGB = [255, 255, 255];
const lightImg = new Img(64, 64);
for (let y = 0; y < 64; y++)
  for (let x = 0; x < 64; x++) {
    const d = Math.hypot(x + 0.5 - 32, y + 0.5 - 32) / 32;
    if (d < 1) lightImg.set(x, y, WHITE, band(1 - d * d));
  }
// The cone: apex at the middle of the left edge, 80 px (5 tiles) long, 35° either side.
const CONE_LEN = 80;
const coneH = 2 * Math.ceil(CONE_LEN * Math.sin((35 * Math.PI) / 180)) + 2;
const cone = new Img(CONE_LEN + 4, coneH);
for (let y = 0; y < coneH; y++)
  for (let x = 0; x < CONE_LEN + 4; x++) {
    const dx = x + 0.5;
    const dy = y + 0.5 - coneH / 2;
    const d = Math.hypot(dx, dy) / CONE_LEN;
    const angle = (Math.atan2(Math.abs(dy), dx) * 180) / Math.PI; // 0° = straight ahead
    if (d >= 1 || angle >= 35) continue;
    // Brightest near the torch and along the middle; dimmer towards the far end and the edges.
    cone.set(x, y, WHITE, band((1 - d ** 1.6) * Math.min(1, (35 - angle) / 10)));
  }

// ─── Write ───────────────────────────────────────────────────────────────────────────────────
const mapPath = join(out, "maps", "barangay.tmj");
if (
  existsSync(mapPath) &&
  !force &&
  JSON.parse(readFileSync(mapPath, "utf8")).tilesets?.[0]?.name === "barangay"
) {
  console.error(
    `${mapPath} exists and may have hand edits from Tiled. Re-run with --force to overwrite it.`,
  );
  process.exit(1);
}
for (const d of ["tiles", "sprites", "maps"]) mkdirSync(join(out, d), { recursive: true });
writeFileSync(join(out, "tiles", "barangay.png"), sheet.png());
writeFileSync(join(out, "sprites", "tanod.png"), tanod.png());
writeFileSync(join(out, "sprites", "kids.png"), kidsSheet.png());
writeFileSync(join(out, "sprites", "glow.png"), glow.png());
writeFileSync(join(out, "sprites", "light.png"), lightImg.png());
writeFileSync(join(out, "sprites", "tikbalang.png"), tikSheet.png());
writeFileSync(join(out, "sprites", "tikbalang-eye.png"), eyeSheet.png());
writeFileSync(join(out, "sprites", "cone.png"), cone.png());
writeFileSync(mapPath, JSON.stringify(tmj) + "\n");
console.log(
  `tileset ${COLS}×${ROWS} (${collides.size} solid tiles), tanod ${HATS.length * SHIRTS.length} looks × 4 frames, ${kidsData.kids.length} kids, ${KID_SPOTS.length} kid spots, ${houses.length} homes, ${lights.length} lights, map ${W}×${H}`,
);
