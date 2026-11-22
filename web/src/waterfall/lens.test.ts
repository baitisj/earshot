import { describe, expect, it } from "vitest";
import { LENS_CORE_HZ, lensScale, lensShape, lensTicks, linearScale } from "./lens";

const low = 440e6;
const span = 25.6e6;

describe("lens scale", () => {
  it("puts the focus in the middle and ±20 kHz at the core edges", () => {
    const s = lensScale(low, span, 446e6);
    expect(s.x(446e6)).toBeCloseTo(0.5, 9);
    expect(s.x(446e6 + LENS_CORE_HZ)).toBeCloseTo(0.625, 9);
    expect(s.x(446e6 - LENS_CORE_HZ)).toBeCloseTo(0.375, 9);
    // Linear inside the core.
    expect(s.x(446e6 + 10e3)).toBeCloseTo(0.5625, 9);
  });

  it("reaches the farther window edge at the side and blanks past the nearer one", () => {
    const s = lensScale(low, span, 446e6);
    const reach = Math.max(446e6 - low, low + span - 446e6);
    expect(s.x(446e6 + reach)).toBeCloseTo(1, 6);
    expect(s.x(low)).toBeGreaterThan(0);
  });

  it("round-trips and stays monotonic", () => {
    const s = lensScale(low, span, 452.3e6);
    let previous = -Infinity;
    for (let x = 0; x <= 1; x += 1 / 997) {
      const hz = s.hz(x);
      expect(hz).toBeGreaterThan(previous);
      previous = hz;
      expect(s.x(hz)).toBeCloseTo(x, 7);
    }
  });

  it("joins the core without a kink", () => {
    const s = lensScale(low, span, 446e6);
    const seam = 0.625;
    expect(s.hzPerWidth(seam + 1e-9) / s.hzPerWidth(seam - 1e-9)).toBeCloseTo(1, 4);
    expect(s.hzPerWidth(0.99)).toBeGreaterThan(s.hzPerWidth(0.7));
  });

  it("falls back to one linear scale when the window is narrow", () => {
    const shape = lensShape(446e6 - 30e3, 60e3, 446e6);
    expect(shape.k).toBe(0);
    const s = lensScale(446e6 - 30e3, 60e3, 446e6);
    expect(s.x(446e6 + 30e3)).toBeCloseTo(1, 9);
    expect(s.x(446e6 + 15e3)).toBeCloseTo(0.75, 9);
  });

  it("matches the linear scale's frame of reference", () => {
    const l = linearScale(low, span);
    expect(l.x(low + span / 2)).toBe(0.5);
    expect(l.hz(0.25)).toBe(low + span / 4);
  });
});

describe("lens ticks", () => {
  it("labels ±20k and ±1M and crowds toward the edges", () => {
    const s = lensScale(low, span, 452.8e6);
    const ticks = lensTicks(s, 1200);
    const labels = ticks.map((t) => t.label).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(["−20k", "+20k", "−1M", "+1M"]));
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].x).toBeGreaterThan(ticks[i - 1].x);
    expect(ticks.every((t) => t.x >= 0 && t.x <= 1)).toBe(true);
  });
});
