import { describe, it, expect } from "vitest";
import { formatDateTime, formatDistance, formatDuration } from "./format";

describe("format helpers", () => {
  it("formats duration", () => {
    expect(formatDuration(59)).toBe("00m59s");
    expect(formatDuration(60)).toBe("01m00s");
    expect(formatDuration(3661)).toBe("1h01m01s");
  });

  it("formats distance", () => {
    expect(formatDistance(0)).toBe("0.00km");
    expect(formatDistance(1234)).toBe("1.23km");
  });

  it("formats datetime", () => {
    const out = formatDateTime("2023-01-01T10:05:00Z");
    expect(out).toMatch(/\d{2} \w{3}, \d{4} \d{2}:\d{2} (am|pm)/);
  });
});
