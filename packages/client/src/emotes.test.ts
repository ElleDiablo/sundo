/** Tests for the emote words (S2-06): one per engine emote, and safe for unknown numbers. */
import { EMOTE_COUNT } from "@sundo/engine";
import { describe, expect, it } from "vitest";
import { EMOTES, emoteText } from "./emotes.ts";

describe("emotes", () => {
  it("has words for every emote the engine allows", () => {
    expect(EMOTES).toHaveLength(EMOTE_COUNT);
  });

  it("gives the words for a number, and nothing for none or an unknown one", () => {
    expect(emoteText(0)).toBe("Dito!");
    expect(emoteText(3)).toBe("Salamat!");
    expect(emoteText(null)).toBeUndefined();
    expect(emoteText(undefined)).toBeUndefined();
    expect(emoteText(9)).toBeUndefined();
  });
});
