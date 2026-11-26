/**
 * Reads maps made in Tiled (https://www.mapeditor.org), saved as JSON (.tmj).
 *
 * The engine only needs to know which tiles are walls, so this keeps the parts it needs and
 * ignores the rest (layer order, opacity, colours). The client draws the same file with Phaser.
 *
 * Rule: a tile is a wall if ANY tile layer has a tile there whose tileset entry has the custom
 * property `collides = true`. So in Tiled, painting a wall/roof/fence/water tile makes it solid
 * automatically; there is no separate collision layer to keep in sync.
 */
import type { TileMap } from "./map.ts";

/** The subset of Tiled's JSON map format this file reads. */
export interface TiledMap {
  readonly width: number; // in tiles
  readonly height: number; // in tiles
  readonly tilewidth: number; // in pixels
  readonly tileheight: number;
  readonly infinite?: boolean;
  readonly layers: readonly TiledLayer[];
  readonly tilesets: readonly TiledTileset[];
}

export type TiledLayer =
  | {
      readonly type: "tilelayer";
      readonly name: string;
      // One number per tile, row by row. 0 = empty; otherwise a "global tile id" (gid).
      readonly data?: readonly number[];
      readonly width?: number;
      readonly height?: number;
    }
  | {
      readonly type: "objectgroup";
      readonly name: string;
      readonly objects: readonly TiledObject[];
    }
  | { readonly type: "imagelayer" | "group"; readonly name: string };

export interface TiledObject {
  readonly name: string;
  readonly type?: string; // called "class" in newer Tiled versions
  readonly class?: string;
  readonly x: number; // in pixels
  readonly y: number;
  readonly point?: boolean;
}

export interface TiledTileset {
  readonly firstgid: number; // the gid of this tileset's first tile
  readonly source?: string; // set when the tileset lives in a separate .tsx file
  readonly tiles?: readonly {
    readonly id: number; // index inside this tileset (gid - firstgid)
    readonly properties?: readonly { readonly name: string; readonly value: unknown }[];
  }[];
}

// Tiled stores "flipped" flags in the top 3 bits of each gid; they don't change the tile itself.
const FLIP_FLAGS = 0xe0000000;
export const TILE_SIZE_PX = 16;

/** Converts a Tiled map into the engine's TileMap (walls only). */
export function mapFromTiled(tiled: TiledMap): TileMap {
  if (tiled.infinite)
    throw new RangeError("infinite maps aren't supported: untick Map ▸ Map Properties ▸ Infinite");
  if (tiled.tilewidth !== TILE_SIZE_PX || tiled.tileheight !== TILE_SIZE_PX) {
    throw new RangeError(
      `tiles must be ${TILE_SIZE_PX}×${TILE_SIZE_PX} px, got ${tiled.tilewidth}×${tiled.tileheight}`,
    );
  }

  const solidGids = collidingGids(tiled.tilesets);
  const { width, height } = tiled;
  const walls: boolean[] = new Array<boolean>(width * height).fill(false);

  for (const layer of tiled.layers) {
    if (layer.type !== "tilelayer") continue;
    if (!layer.data || layer.data.length !== width * height) {
      throw new RangeError(`layer "${layer.name}" should have ${width * height} tiles`);
    }
    layer.data.forEach((gid, i) => {
      // `>>> 0` keeps it an unsigned 32-bit number after clearing the flip bits.
      if (solidGids.has((gid & ~FLIP_FLAGS) >>> 0)) walls[i] = true;
    });
  }
  return { width, height, walls };
}

/** Every gid (across all tilesets) whose tile has `collides = true`. */
function collidingGids(tilesets: readonly TiledTileset[]): Set<number> {
  const gids = new Set<number>();
  for (const ts of tilesets) {
    if (ts.source)
      throw new RangeError(
        `tileset "${ts.source}" is external: embed it in the map (Tiled ▸ Embed Tileset)`,
      );
    for (const tile of ts.tiles ?? []) {
      const collides = tile.properties?.some((p) => p.name === "collides" && p.value === true);
      if (collides) gids.add(ts.firstgid + tile.id);
    }
  }
  return gids;
}

/**
 * Finds a point object by name in an object layer, as a tile position.
 * Used for spawn points: in Tiled, add a Point to the "spawns" layer and name it "player".
 */
export function findTiledPoint(
  tiled: TiledMap,
  layerName: string,
  objectName: string,
): { tileX: number; tileY: number } {
  const [first] = findTiledPoints(tiled, layerName, objectName);
  if (!first) throw new RangeError(`no object named "${objectName}" in layer "${layerName}"`);
  return first;
}

/**
 * Finds EVERY point object with this name in an object layer, as tile positions, in the order
 * they appear in the file. Used for the children's hiding spots (S2-02): 12 points named "kid".
 * Returns an empty list if there are none.
 */
export function findTiledPoints(
  tiled: TiledMap,
  layerName: string,
  objectName: string,
): { tileX: number; tileY: number }[] {
  const layer = tiled.layers.find((l) => l.type === "objectgroup" && l.name === layerName);
  if (!layer || layer.type !== "objectgroup")
    throw new RangeError(`no object layer named "${layerName}"`);
  return layer.objects
    .filter((o) => o.name === objectName)
    .map((o) => ({
      tileX: Math.floor(o.x / tiled.tilewidth),
      tileY: Math.floor(o.y / tiled.tileheight),
    }));
}
