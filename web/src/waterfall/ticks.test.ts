import { describe, expect, it } from "vitest";
import { historyTicks, lineTimes, rowForLine, speedGeometry, speedLabel } from "./ticks";

it("uses round seconds rather than fractional ages of arbitrarily selected rows", () => {
  const times = Array.from({ length: 300 }, (_, i) => 100 - i * 0.0576);
  const ticks = historyTicks(times, 300, 400);
  expect(ticks.map((t) => t.ageSeconds)).toEqual([0, 5, 10, 15]);
  expect(ticks[1].row).toBeCloseTo(5 / 0.0576);
});

it("places ticks using timestamps rather than assuming a fixed row rate", () => {
  expect(historyTicks([100, 99.5, 98, 96, 95], 5, 500)).toEqual([
    { ageSeconds: 0, row: 0 }, { ageSeconds: 1, row: 1 + 1 / 3 },
    { ageSeconds: 2, row: 2 },
    { ageSeconds: 4, row: 3 }, { ageSeconds: 5, row: 4 },
  ]);
});

it("does not label empty history or extend beyond retained visible rows", () => {
  expect(historyTicks([], 300, 400)).toEqual([]);
  expect(historyTicks([1, 0.9], 300, 400)).toEqual([{ ageSeconds: 0, row: 0 }]);
  expect(historyTicks([10, 9, 8, 0], 3, 300).at(-1)?.ageSeconds).toBeLessThanOrEqual(2);
});

it("keeps labels apart across large missing intervals", () => {
  const ticks = historyTicks([100, 99.9, 1, 0], 4, 400);
  for (let i = 1; i < ticks.length; i++)
    expect((ticks[i].row - ticks[i - 1].row) / 4 * 400).toBeGreaterThanOrEqual(60);
});

describe("waterfall speed", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ sequence: 100 + i, time: i * 0.1 }));
  it("maps speeds to lines and groups", () => {
    expect(speedGeometry(0, 300)).toEqual({ group: 1, lines: 300 });
    expect(speedGeometry(-3, 300)).toEqual({ group: 8, lines: 300 });
    expect(speedGeometry(2, 300)).toEqual({ group: 1, lines: 75 });
    expect(speedLabel(-2)).toBe("1/4×");
    expect(speedLabel(1)).toBe("2×");
  });
  it("times each line by its newest row, grouped by sequence", () => {
    // Sequences 100..119 in groups of 4: 116-119, 112-115, ..., 100-103.
    expect(lineTimes(rows, 4, 10)).toEqual([1.9, 1.5, 1.1, 0.7, 0.3].map((t) => expect.closeTo(t, 9)));
    expect(lineTimes(rows, 1, 3)).toEqual([1.9, 1.8, 1.7].map((t) => expect.closeTo(t, 9)));
  });
  it("finds the row behind a line", () => {
    expect(rowForLine(rows, 4, 0)).toBe(19);
    expect(rowForLine(rows, 4, 1)).toBe(15);
    expect(rowForLine(rows, 1, 2)).toBe(17);
    expect(rowForLine(rows, 4, 9)).toBe(-1);
  });
});
