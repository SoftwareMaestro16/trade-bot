import Big from "big.js";
import { describe, expect, it } from "vitest";
import { checkExit } from "../../src/strategy/exitRules.js";
import type { ExitCheckInput } from "../../src/strategy/exitRules.js";

// None of the four PARAMS-CONSERVATIVE.md §7 exit conditions hold: funding is
// positive, currentApr is above the 50% hysteresis floor, basis is tight, the
// symbol is fine, and enough payments are collected that the minimum-hold gate
// is a non-issue. Individual tests override only the field(s) under test.
function baselineInput(): ExitCheckInput {
  return {
    predictedNextFundingRate: new Big("0.0002"),
    currentApr: new Big("0.25"),
    entryApr: new Big("0.20"),
    basisDivergence: new Big("0.001"),
    isDelistedOrContractChanged: false,
    fundingPaymentsCollected: 5,
  };
}

describe("checkExit", () => {
  it("does not exit when none of the four conditions hold (PARAMS-CONSERVATIVE.md §7)", () => {
    const result = checkExit(baselineInput());
    expect(result).toEqual({ shouldExit: false });
  });

  describe("reason 1 — FUNDING_TURNED_NEGATIVE", () => {
    it("exits when predicted next funding is negative and at least one payment was collected", () => {
      const result = checkExit({
        ...baselineInput(),
        predictedNextFundingRate: new Big("-0.0001"),
        fundingPaymentsCollected: 1,
      });
      expect(result).toMatchObject({ shouldExit: true, code: "FUNDING_TURNED_NEGATIVE", urgent: false });
    });

    it("does not exit when fundingPaymentsCollected is 0, even though the predicted rate is negative (FR-303 minimum hold)", () => {
      const result = checkExit({
        ...baselineInput(),
        predictedNextFundingRate: new Big("-0.0001"),
        fundingPaymentsCollected: 0,
      });
      expect(result).toEqual({ shouldExit: false });
    });
  });

  describe("reason 2 — APR_HYSTERESIS_TRIGGERED", () => {
    it("exits when currentApr drops below 50% of entryApr and at least one payment was collected", () => {
      const result = checkExit({
        ...baselineInput(),
        entryApr: new Big("0.20"),
        currentApr: new Big("0.09"), // < 0.20 * 0.5 = 0.10
        fundingPaymentsCollected: 1,
      });
      expect(result).toMatchObject({ shouldExit: true, code: "APR_HYSTERESIS_TRIGGERED", urgent: false });
    });

    it("does not exit exactly at the 50% boundary (currentApr == entryApr * 0.5, strictly-less required)", () => {
      const entryApr = new Big("0.20");
      const result = checkExit({
        ...baselineInput(),
        entryApr,
        currentApr: entryApr.times("0.5"),
        fundingPaymentsCollected: 5,
      });
      expect(result).toEqual({ shouldExit: false });
    });

    it("does not exit when fundingPaymentsCollected is 0, even though currentApr is well below the hysteresis floor (FR-303 minimum hold)", () => {
      const result = checkExit({
        ...baselineInput(),
        entryApr: new Big("0.20"),
        currentApr: new Big("0.01"),
        fundingPaymentsCollected: 0,
      });
      expect(result).toEqual({ shouldExit: false });
    });
  });

  describe("reason 3 — BASIS_DIVERGED", () => {
    it("exits, urgently, when basis divergence exceeds 0.5%", () => {
      const result = checkExit({ ...baselineInput(), basisDivergence: new Big("0.006") });
      expect(result).toMatchObject({ shouldExit: true, code: "BASIS_DIVERGED", urgent: true });
    });

    it("does not exit exactly at the 0.5% boundary — strictly greater-than, not gte (matches risk/economics.ts's threshold convention)", () => {
      const result = checkExit({ ...baselineInput(), basisDivergence: new Big("0.005") });
      expect(result).toEqual({ shouldExit: false });
    });

    it("exits even with zero funding payments collected — emergency exits ignore the minimum hold", () => {
      const result = checkExit({
        ...baselineInput(),
        basisDivergence: new Big("0.006"),
        fundingPaymentsCollected: 0,
      });
      expect(result).toMatchObject({ shouldExit: true, code: "BASIS_DIVERGED", urgent: true });
    });
  });

  describe("reason 4 — DELISTED_OR_CONTRACT_CHANGED", () => {
    it("exits, urgently, when the symbol is delisted or its contract parameters changed", () => {
      const result = checkExit({ ...baselineInput(), isDelistedOrContractChanged: true });
      expect(result).toMatchObject({ shouldExit: true, code: "DELISTED_OR_CONTRACT_CHANGED", urgent: true });
    });

    it("exits even with zero funding payments collected — emergency exits ignore the minimum hold", () => {
      const result = checkExit({
        ...baselineInput(),
        isDelistedOrContractChanged: true,
        fundingPaymentsCollected: 0,
      });
      expect(result).toMatchObject({ shouldExit: true, code: "DELISTED_OR_CONTRACT_CHANGED", urgent: true });
    });
  });

  describe("priority when multiple reasons fire simultaneously (checked in order 3 -> 4 -> 1 -> 2)", () => {
    it("returns BASIS_DIVERGED when all four conditions hold at once", () => {
      const result = checkExit({
        predictedNextFundingRate: new Big("-0.0001"),
        currentApr: new Big("0.01"),
        entryApr: new Big("0.20"),
        basisDivergence: new Big("0.006"),
        isDelistedOrContractChanged: true,
        fundingPaymentsCollected: 0,
      });
      expect(result).toMatchObject({ shouldExit: true, code: "BASIS_DIVERGED", urgent: true });
    });

    it("returns DELISTED_OR_CONTRACT_CHANGED over the planned reasons when basis has not diverged", () => {
      const result = checkExit({
        predictedNextFundingRate: new Big("-0.0001"),
        currentApr: new Big("0.01"),
        entryApr: new Big("0.20"),
        basisDivergence: new Big("0.001"),
        isDelistedOrContractChanged: true,
        fundingPaymentsCollected: 0,
      });
      expect(result).toMatchObject({ shouldExit: true, code: "DELISTED_OR_CONTRACT_CHANGED", urgent: true });
    });

    it("returns FUNDING_TURNED_NEGATIVE over APR_HYSTERESIS_TRIGGERED when neither emergency reason applies", () => {
      const result = checkExit({
        predictedNextFundingRate: new Big("-0.0001"),
        currentApr: new Big("0.01"),
        entryApr: new Big("0.20"),
        basisDivergence: new Big("0.001"),
        isDelistedOrContractChanged: false,
        fundingPaymentsCollected: 1,
      });
      expect(result).toMatchObject({ shouldExit: true, code: "FUNDING_TURNED_NEGATIVE", urgent: false });
    });
  });
});
