import { describe, expect, it } from "vitest";
import { formatDateTime } from "./date";

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
