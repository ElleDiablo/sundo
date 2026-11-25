/**
 * Tests for room codes: the allowed letters, the rude-word filter, and that generated codes are
 * always allowed. The random source is replaced with fixed numbers so results are predictable.
 */
import { describe, expect, it } from "vitest";
import { CODE_LETTERS, generateCode, isAllowedCode } from "./codes.ts";

/** A fake random source that returns the given values in order, then repeats. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};
/** The random value that picks `letter` from CODE_LETTERS. */
const pickLetter = (letter: string) => (CODE_LETTERS.indexOf(letter) + 0.5) / CODE_LETTERS.length;

describe("isAllowedCode", () => {
  it("accepts ordinary 4-letter codes", () => {
    expect(isAllowedCode("BAHO")).toBe(true);
    expect(isAllowedCode("TAKB")).toBe(true);
  });

  it("rejects the wrong length or letters outside the alphabet", () => {
    expect(isAllowedCode("BAH")).toBe(false);
    expect(isAllowedCode("BAHAY")).toBe(false);
    expect(isAllowedCode("baho")).toBe(false);
    expect(isAllowedCode("BALA")).toBe(false); // L is left out (looks like I)
  });

  it("rejects rude words in English and Filipino, and codes containing them", () => {
    for (const code of ["PUTA", "GAGA", "DAMN", "ASSA", "BSEX", "TAEB"]) {
      expect(isAllowedCode(code), code).toBe(false);
    }
  });
});

describe("generateCode", () => {
  it("builds a code from the random values", () => {
    const random = sequence(...[..."TALA".replace("L", "N")].map(pickLetter)); // TANA
    expect(generateCode(random)).toBe("TANA");
  });

  it("skips blocked codes and tries again", () => {
    const random = sequence(...[..."PUTABAHA"].map(pickLetter)); // first PUTA, then BAHA
    expect(generateCode(random)).toBe("BAHA");
  });

  it("only ever produces allowed codes", () => {
    let seed = 1;
    const lcg = () => ((seed = (seed * 48271) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 2000; i++) expect(isAllowedCode(generateCode(lcg))).toBe(true);
  });

  it("gives up loudly if the random source is broken", () => {
    expect(() => generateCode(sequence(...[..."PUTA"].map(pickLetter)))).toThrow(
      /could not generate/,
    );
  });
});
