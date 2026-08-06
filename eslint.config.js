import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // NFR-11 / RR-28 (SRS.md): `strategy/` must not import `exchange/` or
    // `execution/` directly — the risk module's veto has to be structurally
    // unavoidable, not just a convention. Enforced here rather than only in
    // code review, per ARCHITECTURE.md §2's "проверяется статическим анализом
    // графа импортов в CI, а не соглашением".
    plugins: { boundaries },
    settings: {
      // partialMatch: false — files live directly under these dirs (no
      // per-element subfolder), so the pattern must match the full relative
      // file path in one pass; the default (partialMatch: true, folder-oriented)
      // expects `pattern/*` to be a subfolder, which silently classified every
      // file here as unknown (caught via ESLINT_PLUGIN_BOUNDARIES_DEBUG=1,
      // "isUnknown": true).
      "boundaries/elements": [
        { type: "strategy", pattern: "src/strategy/**", partialMatch: false },
        { type: "exchange", pattern: "src/exchange/**", partialMatch: false },
        { type: "execution", pattern: "src/execution/**", partialMatch: false },
      ],
      // The default resolver doesn't know this project's NodeNext convention
      // (source imports `./client.js` for a file that's actually `client.ts`
      // on disk) — without this, every local import silently resolves to
      // "unknown" and the dependency rule never sees a target to check.
      "import/resolver": {
        typescript: true,
      },
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          policies: [
            {
              from: { element: { type: "strategy" } },
              disallow: { to: { element: { types: { anyOf: ["exchange", "execution"] } } } },
              message: "strategy/ must not import exchange/ or execution/ directly — decisions go through risk/ (SRS RR-28).",
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-002: "the only place in this codebase allowed to import bybit-api
    // directly." That claim used to be documentation only, not lint-enforced
    // — `boundaries/dependencies` above governs INTERNAL module-to-module
    // edges (strategy/ -> exchange/), not an external package's import site,
    // so it never actually covered this. `@typescript-eslint/no-restricted-imports`
    // (not core ESLint's, which can't tell a type-only import from a runtime
    // one — a `import type` reference to a bybit-api type carries no runtime
    // footprint and isn't the thing ADR-002 protects against) is the rule
    // that closes that gap. Two named files are a real, reasoned exception,
    // not a hole: collectLiquidations.ts needs bybit-api's WebsocketClient,
    // which exchange/client.ts's RestClientV5 wrapper doesn't cover, and
    // parseLiquidationEvent.ts needs its WS event-shape runtime guard.
    files: ["src/**/*.ts"],
    ignores: [
      "src/exchange/**",
      "src/market-data/collectLiquidations.ts",
      "src/market-data/parseLiquidationEvent.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "bybit-api",
              allowTypeImports: true,
              message:
                "bybit-api may only be imported at runtime from src/exchange/** (ADR-002/NFR-11) or from " +
                "market-data/collectLiquidations.ts + parseLiquidationEvent.ts (documented exception: the " +
                "WS client and its event-shape guard aren't wrapped by exchange/client.ts). Type-only " +
                "imports (`import type`) are unaffected.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // Test fixtures frequently pass `async () => {...}` where the body has no
      // `await` because the *caller's* type signature requires a Promise return
      // (RateLimiter.schedule, BatchBuffer's onFlush) — not because the function
      // was accidentally marked async. Real accidental-async bugs in src/ are
      // still caught; this only relaxes the rule where it's structurally noise.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
);
