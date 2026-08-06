import Big from "big.js";
import { describe, expect, it } from "vitest";
import { checkSlippage, checkTurnover, estimateSlippage } from "../../src/risk/liquidity.js";

describe("checkTurnover", () => {
  it("allows when both perp and spot turnover clear the floor (PARAMS-CONSERVATIVE.md §4)", () => {
    const result = checkTurnover(new Big("150000000"), new Big("30000000"));
    expect(result.allowed).toBe(true);
  });

  it("denies when perp turnover is below 100M USDT", () => {
    const result = checkTurnover(new Big("99999999"), new Big("30000000"));
    expect(result).toMatchObject({ allowed: false, code: "PERP_TURNOVER_TOO_LOW" });
  });

  it("denies when spot turnover is below 20M USDT, even if perp clears easily", () => {
    const result = checkTurnover(new Big("500000000"), new Big("19999999"));
    expect(result).toMatchObject({ allowed: false, code: "SPOT_TURNOVER_TOO_LOW" });
  });

  it("allows exactly at the boundary (100M / 20M inclusive)", () => {
    const result = checkTurnover(new Big("100000000"), new Big("20000000"));
    expect(result.allowed).toBe(true);
  });
});

describe("estimateSlippage", () => {
  it("returns zero slippage and exhausted=true for an empty book", () => {
    const result = estimateSlippage([], new Big("1000"));
    expect(result.exhausted).toBe(true);
    expect(result.filledNotional.toString()).toBe("0");
    expect(result.slippageBp.toString()).toBe("0");
  });

  it("reports exhausted=true and the partial filled notional when depth is insufficient (RISK-REGISTER.md FM-03: never a silent partial estimate)", () => {
    const levels = [{ price: new Big("100"), qty: new Big("1") }];
    const result = estimateSlippage(levels, new Big("150"));
    expect(result.exhausted).toBe(true);
    expect(result.filledNotional.toString()).toBe("100");
  });

  it("computes zero slippage when the target is fully filled within a single level", () => {
    const levels = [{ price: new Big("100"), qty: new Big("2") }];
    const result = estimateSlippage(levels, new Big("50"));
    expect(result.exhausted).toBe(false);
    expect(result.slippageBp.toString()).toBe("0");
  });

  it("computes exact weighted-average slippage across two fully-consumed levels", () => {
    // L1: 1 @ 100 = 100 notional. L2: 1 @ 104 = 104 notional. Target = 204 (exact sum).
    // avg price = 204 / 2 = 102. slippage vs best (100) = 2/100 = 0.02 exactly.
    const levels = [
      { price: new Big("100"), qty: new Big("1") },
      { price: new Big("104"), qty: new Big("1") },
    ];
    const result = estimateSlippage(levels, new Big("204"));
    expect(result.exhausted).toBe(false);
    expect(result.filledNotional.toString()).toBe("204");
    expect(result.slippageBp.toString()).toBe("0.02");
  });
});

/**
 * TEST-CASES.md #51: "живые spot и linear книги тонкого символа (пример:
 * STRKUSDT), when запрошен нотионал $100k, then сайзер возвращает явную
 * ошибку исчерпания глубины, не частичную оценку (FM-03)."
 *
 * Not a synthetic book — this is the REAL top-50 STRKUSDT spot ask side,
 * pulled from this project's own live mainnet collector (orderbook_levels,
 * fetched_at 2026-08-06 ~13:00 UTC) and frozen here. Total real depth across
 * all 50 levels sums to $76,363.42 — genuinely below $100k, so this is a
 * real, not contrived, exhaustion case, and it demonstrates FM-03's own
 * point directly: the SPOT book is the binding constraint here even though
 * STRKUSDT clears PARAMS-CONSERVATIVE.md §4's turnover floors easily on the
 * linear side (real linear-ask depth pulled at the same timestamp summed to
 * ~$303k — plenty for $100k alone, which is exactly why checking only the
 * perp side would have missed this).
 */
describe("estimateSlippage / checkSlippage against a real thin book (TEST-CASES.md #51, STRKUSDT)", () => {
  const realStrkSpotAsks = [
    ["0.0257", "2758.77"], ["0.02571", "27390.33"], ["0.02572", "8751.99"], ["0.02573", "20908.68"],
    ["0.02574", "17323.03"], ["0.02575", "28487.76"], ["0.02576", "13651.94"], ["0.02577", "56321.19"],
    ["0.02578", "62669.19"], ["0.02579", "15584.95"], ["0.0258", "56537.66"], ["0.02581", "59885.79"],
    ["0.02582", "171573.31"], ["0.02583", "13117.3"], ["0.02584", "13124.3"], ["0.02585", "196637.57"],
    ["0.02586", "96480.9"], ["0.02587", "5672.5"], ["0.02589", "896590.5"], ["0.0259", "296.01"],
    ["0.02591", "1822.95"], ["0.02592", "1924.44"], ["0.02593", "246283.13"], ["0.02594", "2941.55"],
    ["0.02595", "6822.95"], ["0.02596", "107849.61"], ["0.02597", "1822.95"], ["0.02598", "294630.87"],
    ["0.02599", "1822.95"], ["0.026", "27329.37"], ["0.02601", "1822.95"], ["0.02602", "53.95"],
    ["0.02604", "98168.77"], ["0.02606", "2297.09"], ["0.02608", "56.6"], ["0.0261", "229.53"],
    ["0.02614", "1822.95"], ["0.02615", "379185.09"], ["0.02616", "287.27"], ["0.02618", "2931.17"],
    ["0.02619", "296.01"], ["0.02626", "54.07"], ["0.02628", "102.96"], ["0.0263", "73.02"],
    ["0.02631", "52.52"], ["0.02632", "53.25"], ["0.02635", "459.22"], ["0.02636", "529.55"],
    ["0.0264", "102.96"], ["0.02641", "229.53"],
  ].map(([price, qty]) => ({ price: new Big(price!), qty: new Big(qty!) }));

  it("reports exhausted=true with the real partial notional (~$76,363), never a silent estimate for the full $100k", () => {
    const result = estimateSlippage(realStrkSpotAsks, new Big("100000"));
    expect(result.exhausted).toBe(true);
    // Genuinely partial: less than requested, not zero, not the target itself.
    expect(result.filledNotional.gt(0)).toBe(true);
    expect(result.filledNotional.lt(new Big("100000"))).toBe(true);
    expect(result.filledNotional.toString()).toBe("76363.422473");
  });

  it("checkSlippage denies with ORDERBOOK_DEPTH_EXHAUSTED, not SLIPPAGE_TOO_HIGH or an allow — the real book genuinely cannot fill $100k, that's a depth failure, not a price-quality one", () => {
    const estimate = estimateSlippage(realStrkSpotAsks, new Big("100000"));
    const result = checkSlippage(estimate);
    expect(result).toMatchObject({ allowed: false, code: "ORDERBOOK_DEPTH_EXHAUSTED" });
  });

  it("the SAME real book comfortably fills a realistic $1,000 target size with depth to spare — proving exhaustion above is about the $100k target, not a broken book", () => {
    const result = estimateSlippage(realStrkSpotAsks, new Big("1000"));
    expect(result.exhausted).toBe(false);
  });
});

describe("checkSlippage", () => {
  it("allows exactly at the 0.05% boundary (PARAMS-CONSERVATIVE.md §6)", () => {
    const result = checkSlippage({ slippageBp: new Big("0.0005"), filledNotional: new Big("100"), exhausted: false });
    expect(result.allowed).toBe(true);
  });

  it("denies just above the boundary", () => {
    const result = checkSlippage({ slippageBp: new Big("0.00050001"), filledNotional: new Big("100"), exhausted: false });
    expect(result).toMatchObject({ allowed: false, code: "SLIPPAGE_TOO_HIGH" });
  });

  it("denies on exhausted depth regardless of the computed slippage value", () => {
    const result = checkSlippage({ slippageBp: new Big("0"), filledNotional: new Big("50"), exhausted: true });
    expect(result).toMatchObject({ allowed: false, code: "ORDERBOOK_DEPTH_EXHAUSTED" });
  });
});
