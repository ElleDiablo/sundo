/**
 * Room codes: 4 letters that are easy to read aloud and type, like BAHO or TALA.
 *
 * I and L are left out (they look alike in small pixel fonts), and so are Q, X and Z (rare in
 * Filipino words), so codes read like words: BAHO, TALA, SUKA.
 * Codes that are, or contain, a rude word in English or Filipino are rejected (GDD §8, ADR-0005:
 * players can't type chat, so the only words the game ever shows are these codes and emotes).
 */
export const CODE_LETTERS = "ABCDEFGHJKMNOPRSTUVWY";
export const CODE_LENGTH = 4;

/**
 * Words a code must not be or contain. Kept short and lowercase; matching ignores case.
 * Three-letter entries also block any code containing them (e.g. "XSEX" would be blocked by "sex").
 */
const BLOCKED = [
  // English
  "ass",
  "cum",
  "fag",
  "fck",
  "fuk",
  "gay",
  "jew",
  "kkk",
  "nig",
  "sex",
  "tit",
  "wtf",
  "anal",
  "anus",
  "butt",
  "cock",
  "coon",
  "crap",
  "cunt",
  "damn",
  "dick",
  "dyke",
  "fuck",
  "hell",
  "homo",
  "jerk",
  "jism",
  "kike",
  "milf",
  "nazi",
  "piss",
  "poop",
  "porn",
  "rape",
  "scum",
  "shit",
  "slag",
  "slut",
  "spic",
  "suck",
  "turd",
  "twat",
  "wank",
  "whor",
  // Filipino / Taglish
  "puta",
  "puke",
  "pek",
  "tae",
  "tite",
  "titi",
  "kupal",
  "gago",
  "gaga",
  "ulol",
  "ulul",
  "bobo",
  "tanga",
  "pakyu",
  "pakyo",
  "kantot",
  "jakol",
  "bayag",
  "burat",
  "libog",
  "lintik",
  "hayop",
  "demonyo",
  "suso",
  "utong",
  "bilat",
  "kiki",
];

/** True if the code is safe to show: right shape, allowed letters, no blocked word inside. */
export function isAllowedCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  if ([...code].some((ch) => !CODE_LETTERS.includes(ch))) return false;
  const lower = code.toLowerCase();
  return !BLOCKED.some((word) => word.length <= CODE_LENGTH && lower.includes(word));
}

/**
 * Makes a random allowed code. `random` returns a number in [0, 1), like Math.random; it's passed
 * in so tests can make the result predictable.
 */
export function generateCode(random: () => number): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_LETTERS[Math.floor(random() * CODE_LETTERS.length)];
    }
    if (isAllowedCode(code)) return code;
  }
  // 21^4 ≈ 194,000 codes and only a tiny fraction are blocked, so this means `random` is broken.
  throw new Error("could not generate an allowed room code");
}
