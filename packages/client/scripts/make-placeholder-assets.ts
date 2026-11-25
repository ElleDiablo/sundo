/**
 * Generates the placeholder art and the starter map for S1-01.
 *
 *   npm run assets -w @sundo/client
 *
 * Writes:
 *   public/assets/tiles/placeholder.png   16×16 tiles in flat colours (my own palette, no downloads)
 *   public/assets/sprites/tanod.png       a 12×22 stand-in player
 *   public/assets/maps/barangay.tmj       a 48×32 Tiled map (open it in Tiled to edit)
 *
 * Run it once. After that, barangay.tmj is edited by hand in Tiled; running this again
 * would overwrite those edits, so the script refuses unless given --force.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "assets");
const force = process.argv.includes("--force");

// ─── A tiny PNG writer (RGBA, no compression tricks) ─────────────────────────────────────────
type RGBA = [number, number, number, number];
function png(width: number, height: number, pixel: (x: number, y: number) => RGBA): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      raw.set(p, y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const hex = (h: string, a = 255): RGBA => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
  a,
];
const noise = (x: number, y: number, s: number) => {
  let h = Math.imul(x + s * 131, 374761393) ^ Math.imul(y + s * 977, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// ─── Tileset: one row of 16 tiles. The index is the tile id in Tiled (gid = id + 1). ──────────
interface TileDef {
  name: string;
  collides: boolean;
  draw: (x: number, y: number) => RGBA;
}
const flat = (a: string, b: string, s: number) => (x: number, y: number) =>
  hex(noise(x, y, s) < 0.7 ? a : b);
const TILES: TileDef[] = [
  { name: "grass", collides: false, draw: flat("#2a4224", "#2f4a29", 1) },
  {
    name: "grass-tufts",
    collides: false,
    draw: (x, y) =>
      hex(
        (x + y * 3) % 7 === 0 && y % 4 === 2
          ? "#46663a"
          : noise(x, y, 2) < 0.7
            ? "#2a4224"
            : "#24391f",
      ),
  },
  { name: "path", collides: false, draw: flat("#6b5236", "#5e4730", 3) },
  {
    name: "paddy-water",
    collides: true,
    draw: (x, y) =>
      hex(
        x % 5 === 1 && (y === 6 || y === 12)
          ? "#4f7a3a"
          : noise(x, y, 4) < 0.85
            ? "#1b3748"
            : "#16303e",
      ),
  },
  { name: "dike", collides: false, draw: flat("#4a3a26", "#544430", 5) },
  {
    name: "creek",
    collides: true,
    draw: (x, y) =>
      hex((x + y * 2) % 9 === 0 ? "#3d6a80" : noise(x, y, 6) < 0.6 ? "#173040" : "#1b3748"),
  },
  {
    name: "bridge",
    collides: false,
    draw: (x, y) => hex(y % 4 === 0 ? "#4a3320" : x === 0 || x === 15 ? "#3e2f17" : "#7a5530"),
  },
  { name: "wall-bamboo", collides: true, draw: (x) => hex(x % 3 === 0 ? "#98733f" : "#b08a52") },
  {
    name: "roof-thatch",
    collides: true,
    draw: (x, y) => hex(y % 4 === 0 ? "#4e3c1e" : noise(x, y, 7) < 0.5 ? "#7a6234" : "#8a7240"),
  },
  { name: "roof-tin", collides: true, draw: (x) => hex(x % 2 === 0 ? "#6f7478" : "#585d61") },
  {
    name: "fence",
    collides: true,
    draw: (x, y) =>
      y === 6 || y === 11 || x === 2 || x === 12
        ? hex(y === 6 || y === 11 ? "#aa9b69" : "#8b7e5b")
        : hex("#2a4224"),
  },
  {
    name: "bamboo",
    collides: true,
    draw: (x, y) =>
      x >= 6 && x <= 9
        ? hex(y % 6 === 0 ? "#2c451d" : x < 8 ? "#5f8a3e" : "#3f6128")
        : hex(noise(x, y, 8) < 0.5 ? "#1b2a19" : "#1f301c"),
  },
  {
    name: "tree",
    collides: true,
    draw: (x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      return d < 7.5
        ? hex(d < 3 && x < 8 ? "#46561c" : noise(x, y, 9) < 0.6 ? "#2a5428" : "#1e2e1d")
        : hex("#24391f");
    },
  },
  {
    name: "doorway",
    collides: false,
    draw: (x, y) => hex(x < 2 || x > 13 || y < 2 ? "#4a3320" : "#f0a24a"),
  },
  {
    name: "plaza",
    collides: false,
    draw: (x, y) =>
      hex(x % 8 === 0 || y % 8 === 0 ? "#5a5a52" : noise(x, y, 10) < 0.7 ? "#7a7a6e" : "#6e6e62"),
  },
  {
    name: "wall-concrete",
    collides: true,
    draw: (x, y) =>
      hex(y > 12 ? "#788480" : noise(x >> 2, y >> 2, 11) < 0.8 ? "#bdc7cf" : "#a1a4a1"),
  },
];
const T = Object.fromEntries(TILES.map((t, i) => [t.name, i + 1])) as Record<string, number>; // name → gid

// ─── Map: 48 × 32 tiles ──────────────────────────────────────────────────────────────────────
const W = 48,
  H = 32;
const ground = new Array<number>(W * H).fill(T["grass"]!);
const objects = new Array<number>(W * H).fill(0);
const at = (x: number, y: number) => y * W + x;
const setG = (x: number, y: number, gid: number) => {
  if (x >= 0 && y >= 0 && x < W && y < H) ground[at(x, y)] = gid;
};
const setO = (x: number, y: number, gid: number) => {
  if (x >= 0 && y >= 0 && x < W && y < H) objects[at(x, y)] = gid;
};
const rect = (x0: number, y0: number, w: number, h: number, fn: (x: number, y: number) => void) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) fn(x, y);
};

// grass variety
rect(0, 0, W, H, (x, y) => {
  if (noise(x, y, 20) < 0.18) setG(x, y, T["grass-tufts"]!);
});
// paths: main road (rows 15–16), north–south road (cols 23–24), spurs to doors
rect(1, 15, W - 2, 2, (x, y) => setG(x, y, T["path"]!));
rect(23, 3, 2, 26, (x, y) => setG(x, y, T["path"]!));
// kapilya plaza (top centre): stone square + chapel
rect(19, 3, 10, 6, (x, y) => setG(x, y, T["plaza"]!));
rect(21, 1, 6, 2, (x, y) => setO(x, y, T["roof-tin"]!));
rect(21, 3, 6, 1, (x, y) => setO(x, y, T["wall-concrete"]!));
setO(23, 3, T["doorway"]!);
setO(24, 3, T["doorway"]!);
// a house: 4 wide, 2 rows of roof, 1 row of wall with a lit doorway, path to the road
function house(x: number, y: number, roof = "roof-thatch", wall = "wall-bamboo") {
  rect(x, y, 4, 2, (a, b) => setO(a, b, T[roof]!));
  rect(x, y + 2, 4, 1, (a, b) => setO(a, b, T[wall]!));
  setO(x + 1, y + 2, T["doorway"]!);
  const roadRow = 15;
  const from = y + 3,
    to = roadRow;
  for (let r = Math.min(from, to); r <= Math.max(from, to - 1); r++)
    if (ground[at(x + 1, r)] !== T["creek"]) setG(x + 1, r, T["path"]!);
}
// creek (cols 16–17) with two crossings: the road bridge and a plank near the grove
rect(16, 1, 2, H - 2, (x, y) => setG(x, y, T["creek"]!));
rect(16, 15, 2, 2, (x, y) => setG(x, y, T["bridge"]!));
rect(16, 26, 2, 1, (x, y) => setG(x, y, T["bridge"]!));
// five houses (each child's home) and the sari-sari store
house(4, 4);
house(10, 8);
house(36, 3);
house(42, 9);
house(18, 19);
rect(30, 9, 5, 2, (x, y) => setO(x, y, T["roof-tin"]!));
rect(30, 11, 5, 2, (x, y) => setO(x, y, T["wall-concrete"]!));
setO(32, 12, T["doorway"]!);
rect(32, 13, 1, 2, (x, y) => setG(x, y, T["path"]!));
// rice paddies (bottom right): water with a grid of walkable dikes, fenced, one gap
rect(28, 19, 19, 12, (x, y) => setG(x, y, T["paddy-water"]!));
rect(28, 19, 19, 12, (x, y) => {
  if ((y - 19) % 3 === 0 || (x - 28) % 4 === 0) setG(x, y, T["dike"]!);
});
rect(28, 18, 19, 1, (x, y) => {
  if (x !== 32) setO(x, y, T["fence"]!);
});
// bamboo grove (bottom left): scattered stalks the player weaves between
rect(1, 19, 14, 11, (x, y) => {
  setG(x, y, T["grass"]!);
  if (noise(x, y, 30) < 0.34) setO(x, y, T["bamboo"]!);
});
rect(1, 26, 15, 1, (x, y) => {
  setO(x, y, 0);
  setG(x, y, T["path"]!);
}); // a trail through it to the plank bridge
// trees around the edge, a few in the open
rect(0, 0, W, H, (x, y) => {
  if (x === 0 || y === 0 || x === W - 1 || y === H - 1) {
    setO(x, y, T["tree"]!);
    setG(x, y, T["grass"]!);
  }
});
for (const [x, y] of [
  [8, 13],
  [13, 3],
  [29, 6],
  [39, 14],
  [20, 22],
  [26, 27],
  [44, 6],
] as const)
  setO(x, y, T["tree"]!);
// keep roads clear
rect(1, 15, W - 2, 2, (x, y) => {
  if (objects[at(x, y)] === T["tree"] || objects[at(x, y)] === T["bamboo"]) setO(x, y, 0);
});

const map = {
  type: "map",
  version: "1.10",
  tiledversion: "1.12.2",
  orientation: "orthogonal",
  renderorder: "right-down",
  infinite: false,
  width: W,
  height: H,
  tilewidth: 16,
  tileheight: 16,
  nextlayerid: 4,
  nextobjectid: 2,
  layers: [
    {
      id: 1,
      name: "ground",
      type: "tilelayer",
      width: W,
      height: H,
      x: 0,
      y: 0,
      opacity: 1,
      visible: true,
      data: ground,
    },
    {
      id: 2,
      name: "objects",
      type: "tilelayer",
      width: W,
      height: H,
      x: 0,
      y: 0,
      opacity: 1,
      visible: true,
      data: objects,
    },
    {
      id: 3,
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
          x: 24 * 16 + 8,
          y: 6 * 16 + 8,
          width: 0,
          height: 0,
          rotation: 0,
          visible: true,
        },
      ],
    },
  ],
  tilesets: [
    {
      firstgid: 1,
      name: "placeholder",
      image: "../tiles/placeholder.png",
      imagewidth: TILES.length * 16,
      imageheight: 16,
      tilewidth: 16,
      tileheight: 16,
      tilecount: TILES.length,
      columns: TILES.length,
      margin: 0,
      spacing: 0,
      tiles: TILES.map((t, id) => ({
        id,
        type: t.name,
        properties: [{ name: "collides", type: "bool", value: t.collides }],
      })),
    },
  ],
};

// ─── Player stand-in: salakot, yellow shirt, dark trousers ───────────────────────────────────
const TANOD = [
  "....hhhh....",
  "..hhhhhhhh..",
  "hhHHHHHHHHhh",
  "...kssssk...",
  "...sesses...",
  "...ssssss...",
  "..yyyyyyyy..",
  ".syyyyyyyys.",
  ".syyyYyyyys.",
  ".syyyyyyyys.",
  "..yyyyyyyy..",
  "..pppppppp..",
  "..pppppppp..",
  "..ppp..ppp..",
  "..ppp..ppp..",
  "..ppp..ppp..",
  "..ppp..ppp..",
  "..ppp..ppp..",
  "..sss..sss..",
  ".ffff..ffff.",
];
const KEY: Record<string, string> = {
  h: "#d3a774",
  H: "#aa9b69",
  k: "#2a2018",
  s: "#c38656",
  e: "#180903",
  y: "#e4a755",
  Y: "#c9932a",
  p: "#342b1e",
  f: "#4e412c",
};
const tanod = png(12, TANOD.length, (x, y) => {
  const ch = TANOD[y]![x]!;
  return ch === "." ? [0, 0, 0, 0] : hex(KEY[ch]!);
});

// ─── Write ───────────────────────────────────────────────────────────────────────────────────
const mapPath = join(root, "maps", "barangay.tmj");
if (existsSync(mapPath) && !force) {
  console.error(
    `${mapPath} already exists and may have hand edits from Tiled. Re-run with --force to overwrite it.`,
  );
  process.exit(1);
}
for (const d of ["tiles", "sprites", "maps"]) mkdirSync(join(root, d), { recursive: true });
writeFileSync(
  join(root, "tiles", "placeholder.png"),
  png(TILES.length * 16, 16, (x, y) => TILES[x >> 4]!.draw(x & 15, y)),
);
writeFileSync(join(root, "sprites", "tanod.png"), tanod);
writeFileSync(mapPath, JSON.stringify(map, null, 1) + "\n");
console.log(`wrote ${TILES.length} tiles, the tanod sprite and a ${W}×${H} map`);
