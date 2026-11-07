import { describe, expect, it } from "vitest";
import { formatDateTime, usableDate } from "./date";

describe("usableDate", () => {
  it("正常时间原样保留", () => {
    expect(usableDate("2024-01-01T10:59:02Z")).toBe("2024-01-01T10:59:02Z");
  });

  it("零值时间与早于 1970 的时间都算「没有时间」", () => {
    // Go 的零值时间：Date.parse 会当成公元 1 年的合法日期，
    // 按时间排序时它会永远垫底，看起来像「最旧的那本」。
    expect(usableDate("0001-01-01T00:00:00Z")).toBeUndefined();
    expect(usableDate("1969-01-01T00:00:00Z")).toBeUndefined();
  });

  it("缺失与无效时间都算「没有时间」", () => {
    expect(usableDate(undefined)).toBeUndefined();
    expect(usableDate(null)).toBeUndefined();
    expect(usableDate("")).toBeUndefined();
    expect(usableDate("not-a-date")).toBeUndefined();
  });
});

describe("formatDateTime", () => {
  it("按本地时区展示精确到分钟的时间", () => {
    const value = formatDateTime("2026-11-01T08:30:00Z");
    expect(value).not.toBe("—");
    expect(value).toContain("2026");
    expect(value).not.toContain("T08:30:00Z");
    expect(value).not.toContain("Z");
  });

  it("缺失、无效与零值时间都显示为占位符", () => {
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
    expect(formatDateTime("0001-01-01T00:00:00Z")).toBe("—");
  });
});
