import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/cdk.out/**", "**/node_modules/**", "notes/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // ADR-0004: the engine must be deterministic. Same seed + same inputs = same result.
    files: ["packages/engine/src/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "Use the seeded RNG (createRng) instead (ADR-0004).",
        },
        {
          object: "Date",
          property: "now",
          message: "The engine has no clock; time comes from ticks (ADR-0004).",
        },
        {
          object: "performance",
          property: "now",
          message: "The engine has no clock; time comes from ticks (ADR-0004).",
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "window",
          message: "The engine runs in Node and tests too; no browser APIs (ADR-0004).",
        },
        {
          name: "document",
          message: "The engine runs in Node and tests too; no browser APIs (ADR-0004).",
        },
        { name: "fetch", message: "The engine does no networking (ADR-0004)." },
      ],
    },
  },
);
