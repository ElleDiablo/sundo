/**
 * Tests for reading Tiled maps into the engine: which tiles are walls (the `collides` property),
 * Tiled's flip flags and tileset gid offsets, clear errors for maps the engine can't read, and
 * finding spawn points (one by name, or every point with a name, like the kids' hiding spots).
 */
import { describe, expect, it } from "vitest";
import { findTiledPoint, findTiledPoints, mapFromTiled, type TiledMap } from "./tiled.ts";

/** A 3 × 2 map. Tileset: id 0 = grass, id 1 = wall (collides), id 2 = roof (collides). */
function sample(overrides: Partial<TiledMap> = {}): TiledMap {
  return {
    width: 3,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    tilesets: [
      {
        firstgid: 1,
        tiles: [
          { id: 1, properties: [{ name: "collides", value: true }] },
          { id: 2, properties: [{ name: "collides", value: true }] },
          { id: 0, properties: [{ name: "collides", value: false }] },
        ],
      },
    ],
    layers: [
      { type: "tilelayer", name: "ground", data: [1, 1, 1, 1, 2, 1] },
      { type: "tilelayer", name: "objects", data: [0, 3, 0, 0, 0, 0] },
      {
        type: "objectgroup",
        name: "spawns",
        objects: [{ name: "player", x: 40, y: 20, point: true }],
      },
    ],
    ...overrides,
  };
}

describe("mapFromTiled", () => {
  it("marks a tile as wall if any layer has a colliding tile there", () => {
    expect(mapFromTiled(sample())).toEqual({
      width: 3,
      height: 2,
      walls: [false, true, false, false, true, false],
    });
  });

  it("ignores Tiled's flip flags on gids", () => {
    const flipped = (2 | 0x80000000) >>> 0; // the wall tile, flipped horizontally
    const map = mapFromTiled(
      sample({ layers: [{ type: "tilelayer", name: "ground", data: [flipped, 1, 1, 1, 1, 1] }] }),
    );
    expect(map.walls[0]).toBe(true);
  });

  it("works out gids for a second tileset from its firstgid", () => {
    const map = mapFromTiled(
      sample({
        tilesets: [
          { firstgid: 1 },
          { firstgid: 101, tiles: [{ id: 4, properties: [{ name: "collides", value: true }] }] },
        ],
        layers: [{ type: "tilelayer", name: "ground", data: [105, 1, 1, 1, 1, 104] }],
      }),
    );
    expect(map.walls).toEqual([true, false, false, false, false, false]);
  });

  it("rejects maps it can't read correctly", () => {
    expect(() => mapFromTiled(sample({ infinite: true }))).toThrow(/infinite/);
    expect(() => mapFromTiled(sample({ tilewidth: 32 }))).toThrow(/16×16/);
    expect(() =>
      mapFromTiled(sample({ tilesets: [{ firstgid: 1, source: "tiles.tsx" }] })),
    ).toThrow(/Embed Tileset/);
    expect(() =>
      mapFromTiled(sample({ layers: [{ type: "tilelayer", name: "ground", data: [1, 1] }] })),
    ).toThrow(/should have 6 tiles/);
  });
});

describe("findTiledPoint", () => {
  it("returns the tile that contains the named point", () => {
    expect(findTiledPoint(sample(), "spawns", "player")).toEqual({ tileX: 2, tileY: 1 });
  });

  it("explains what's missing", () => {
    expect(() => findTiledPoint(sample(), "nope", "player")).toThrow(
      /no object layer named "nope"/,
    );
    expect(() => findTiledPoint(sample(), "spawns", "child")).toThrow(/no object named "child"/);
  });
});

describe("findTiledPoints", () => {
  it("returns every point with the name, in file order, and [] when there are none", () => {
    const layers = sample().layers.map((l) =>
      l.type === "objectgroup"
        ? {
            ...l,
            objects: [
              ...l.objects,
              { name: "kid", x: 4, y: 4, point: true },
              { name: "kid", x: 20, y: 30, point: true },
            ],
          }
        : l,
    );
    expect(findTiledPoints(sample({ layers }), "spawns", "kid")).toEqual([
      { tileX: 0, tileY: 0 },
      { tileX: 1, tileY: 1 },
    ]);
    expect(findTiledPoints(sample(), "spawns", "kid")).toEqual([]);
  });
});
