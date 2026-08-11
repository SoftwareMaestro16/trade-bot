import { describe, expect, it } from "vitest";
import { checkDelisting, DEFAULT_DELISTING_BLOCK_WINDOW_MS } from "../../src/risk/delisting.js";

const NOW = 1_786_000_000_000;
const day = 24 * 60 * 60 * 1000;

describe("checkDelisting", () => {
  it("пропускает обычный перпетуал (deliveryTime == 0)", () => {
    expect(checkDelisting(0, NOW).allowed).toBe(true);
  });

  it("блокирует пару с делистингом в пределах окна", () => {
    // делистинг через 10 дней — внутри 45-дневного окна.
    const result = checkDelisting(NOW + 10 * day, NOW);
    expect(result).toMatchObject({ allowed: false, code: "DELISTING_SCHEDULED" });
  });

  it("блокирует уже прошедший делистинг (пара на выходе/снята)", () => {
    expect(checkDelisting(NOW - day, NOW)).toMatchObject({ allowed: false, code: "DELISTING_SCHEDULED" });
  });

  it("пропускает делистинг далеко за окном", () => {
    expect(checkDelisting(NOW + 60 * day, NOW).allowed).toBe(true);
  });

  it("уважает границу окна (ровно на окне — блок, чуть дальше — пропуск)", () => {
    expect(checkDelisting(NOW + DEFAULT_DELISTING_BLOCK_WINDOW_MS, NOW).allowed).toBe(false);
    expect(checkDelisting(NOW + DEFAULT_DELISTING_BLOCK_WINDOW_MS + 1000, NOW).allowed).toBe(true);
  });

  it("уважает переданное окно", () => {
    const sevenDays = 7 * day;
    expect(checkDelisting(NOW + 10 * day, NOW, sevenDays).allowed).toBe(true); // 10д > 7д окна
    expect(checkDelisting(NOW + 5 * day, NOW, sevenDays).allowed).toBe(false);
  });

  it("fail closed при нечисловом времени", () => {
    expect(checkDelisting(NaN, NOW)).toMatchObject({ allowed: false, code: "DELISTING_TIME_UNKNOWN" });
    expect(checkDelisting(NOW + day, NaN)).toMatchObject({ allowed: false, code: "DELISTING_TIME_UNKNOWN" });
  });

  it("реальный VANRYUSDT deliveryTime блокируется (2026-08-11)", () => {
    // deliveryTime=1786525200000, проверено против живого instruments-info.
    expect(checkDelisting(1_786_525_200_000, 1_786_000_000_000)).toMatchObject({
      allowed: false,
      code: "DELISTING_SCHEDULED",
    });
  });
});
