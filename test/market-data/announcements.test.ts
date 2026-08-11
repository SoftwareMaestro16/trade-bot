import { describe, expect, it } from "vitest";
import { filterRelevantAnnouncements, formatAnnouncementsContext } from "../../src/market-data/announcements.js";

const NOW = 1_800_000_000_000;
const day = 24 * 60 * 60 * 1000;

describe("filterRelevantAnnouncements", () => {
  const raw = [
    { title: "Bybit Will Delist ABCUSDT Perpetual", type: { key: "delistings" }, url: "u1", publishTime: String(NOW - day) },
    { title: "New Listing: XYZUSDT", type: { key: "new_crypto" }, url: "u2", publishTime: String(NOW - 2 * day) },
    { title: "Scheduled Maintenance", type: { key: "maintenance_updates" }, url: "u3", publishTime: String(NOW) },
    { title: "Old delist", type: { key: "delistings" }, url: "u4", publishTime: String(NOW - 30 * day) },
    { title: "", type: { key: "new_crypto" }, url: "u5", publishTime: String(NOW) },
  ];

  it("оставляет только листинги/делистинги в окне, новейшие первыми", () => {
    const out = filterRelevantAnnouncements(raw, NOW, 14);
    expect(out.map((a) => a.title)).toEqual(["Bybit Will Delist ABCUSDT Perpetual", "New Listing: XYZUSDT"]);
  });

  it("отсекает обслуживание, пустые заголовки и слишком старые", () => {
    const out = filterRelevantAnnouncements(raw, NOW, 14);
    expect(out.some((a) => a.typeKey === "maintenance_updates")).toBe(false);
    expect(out.some((a) => a.title === "")).toBe(false);
    expect(out.some((a) => a.title === "Old delist")).toBe(false);
  });

  it("поддерживает dateTimestamp как число, если publishTime отсутствует", () => {
    const out = filterRelevantAnnouncements(
      [{ title: "Delist QQQ", type: { key: "delistings" }, url: "u", dateTimestamp: NOW - day }],
      NOW,
    );
    expect(out).toHaveLength(1);
  });
});

describe("formatAnnouncementsContext", () => {
  it("пустая строка, если анонсов нет", () => {
    expect(formatAnnouncementsContext([])).toBe("");
  });

  it("группирует по делистингам и листингам с заголовками", () => {
    const ctx = formatAnnouncementsContext([
      { title: "Delist ABCUSDT", typeKey: "delistings", url: "", publishTimeMs: NOW },
      { title: "List XYZUSDT", typeKey: "new_crypto", url: "", publishTimeMs: NOW },
    ]);
    expect(ctx).toContain("Делистинги:");
    expect(ctx).toContain("Delist ABCUSDT");
    expect(ctx).toContain("Листинги:");
    expect(ctx).toContain("List XYZUSDT");
  });
});
