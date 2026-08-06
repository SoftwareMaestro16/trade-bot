import { describe, expect, it } from "vitest";
import { ALL_CLASSIFIED_CODES, classifyRetCode } from "../../src/execution/retCodeClassifier.js";

describe("classifyRetCode", () => {
  it("classifies a representative balance/margin code as FATAL_ABORT_PAIR", () => {
    expect(classifyRetCode("http", 110007)).toBe("FATAL_ABORT_PAIR");
  });

  it("classifies a representative ambiguous-outcome code as RESOLVE_BY_QUERY", () => {
    expect(classifyRetCode("http", 110072)).toBe("RESOLVE_BY_QUERY");
  });

  it("classifies a representative transient code as RETRYABLE_WITH_BACKOFF", () => {
    expect(classifyRetCode("http", 10006)).toBe("RETRYABLE_WITH_BACKOFF");
  });

  it("defaults to UNCLASSIFIED_HALT for an unrecognized code — never guessed as retryable or harmless", () => {
    expect(classifyRetCode("http", 999999)).toBe("UNCLASSIFIED_HALT");
  });

  it("classifies the corrected code 110094 ('notional below lower limit') as FATAL_ABORT_PAIR", () => {
    expect(classifyRetCode("http", 110094)).toBe("FATAL_ABORT_PAIR");
  });

  it("does NOT classify 170094 as fatal — that code does not exist on Bybit's V5 error page; treating it as known would be repeating the exact mistake this table corrects", () => {
    expect(classifyRetCode("http", 170094)).toBe("UNCLASSIFIED_HALT");
  });

  it("classifies 110079 (order alive, mid-transition on the matching engine) as retryable, not fatal", () => {
    // RISK-REGISTER.md FM-54: this is the code where a naive two-bucket
    // classifier breaks mid-unwind — the order is NOT gone, so treating it as
    // fatal would abandon a leg that is actually still there.
    expect(classifyRetCode("http", 110079)).toBe("RETRYABLE_WITH_BACKOFF");
  });

  it("classifies price-band codes (FM-36) as PRICE_BAND_REPRICE_REQUIRED, not RETRYABLE_WITH_BACKOFF — FM-36 explicitly forbids retrying these with the same price", () => {
    expect(classifyRetCode("http", 110003)).toBe("PRICE_BAND_REPRICE_REQUIRED");
    expect(classifyRetCode("http", 110120)).toBe("PRICE_BAND_REPRICE_REQUIRED");
    expect(classifyRetCode("http", 110121)).toBe("PRICE_BAND_REPRICE_REQUIRED");
    expect(classifyRetCode("http", 170192)).toBe("PRICE_BAND_REPRICE_REQUIRED");
    expect(classifyRetCode("http", 170193)).toBe("PRICE_BAND_REPRICE_REQUIRED");
    expect(classifyRetCode("http", 170194)).toBe("PRICE_BAND_REPRICE_REQUIRED");
  });

  it("classifies 10016 per the HTTP/UTA table ('Server error') as RESOLVE_BY_QUERY", () => {
    // The WS table's different meaning for the same number ("internal server
    // error; Service is restarting") is exactly why this function takes a
    // `transport` parameter — this project has no verified WS retCode table
    // yet, so only the "http" meaning is tested or classified at all.
    expect(classifyRetCode("http", 10016)).toBe("RESOLVE_BY_QUERY");
  });
});

describe("ALL_CLASSIFIED_CODES — table completeness (RISK-REGISTER.md FM-54)", () => {
  it("has no code appearing in more than one class", () => {
    const classes = Object.values(ALL_CLASSIFIED_CODES);
    for (let i = 0; i < classes.length; i++) {
      for (let j = i + 1; j < classes.length; j++) {
        const a = classes[i]!;
        const b = classes[j]!;
        const overlap = [...a].filter((code) => b.has(code));
        expect(overlap).toEqual([]);
      }
    }
  });

  it("contains no zero, negative, or non-integer entries (a malformed transcription would produce these)", () => {
    for (const set of Object.values(ALL_CLASSIFIED_CODES)) {
      for (const code of set) {
        expect(Number.isInteger(code)).toBe(true);
        expect(code).toBeGreaterThan(0);
      }
    }
  });

  it("every classified code round-trips through classifyRetCode into its own class", () => {
    for (const [className, codes] of Object.entries(ALL_CLASSIFIED_CODES)) {
      for (const code of codes) {
        expect(classifyRetCode("http", code)).toBe(className);
      }
    }
  });
});
