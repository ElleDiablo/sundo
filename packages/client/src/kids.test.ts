/**
 * Tests for the children's names and spritesheet rows (S2-02): one name per engine child, and
 * every id maps to a row that exists, even an unexpected one from a newer host.
 */
import { describe, expect, it } from "vitest";
import { KID_COUNT } from "@sundo/engine";
import { KID_NAMES, kidRow } from "./kids.ts";

describe("kids", () => {
  it("names every child the engine places", () => {
    expect(KID_NAMES).toHaveLength(KID_COUNT);
  });

  it("maps ids to spritesheet rows, falling back to row 0", () => {
    expect(kidRow("k0")).toBe(0);
    expect(kidRow("k4")).toBe(4);
    expect(kidRow("k9")).toBe(0);
    expect(kidRow("zz")).toBe(0);
  });
});
