/**
 * Frequency ↔ horizontal position for the waterfall, linear or through a lens.
 *
 * The lens keeps the focus (the tuned frequency) in the middle of the width. The middle
 * quarter shows ±20 kHz around it on a linear scale; outside that the scale grows
 * exponentially (logarithmic in distance from the focus) out to the farther edge of the
 * receiver window, joining the linear core without a kink. Both sides use the same scale,
 * so equal distances from the focus sit at equal distances from the middle, and the part
 * past the nearer window edge is blank.
 */
export const LENS_CORE_HZ = 20_000;
/** Width of the linear core, as a fraction of the whole width (both sides together). */
export const LENS_CORE_FRACTION = 0.25;

export interface LensShape {
  focusHz: number;
  /** Half-width of the linear core, Hz. */
  coreHz: number;
  /** Core width as a fraction of the half-width (0..1); equals LENS_CORE_FRACTION. */
  core: number;
  /** Growth rate of the tails per unit of half-width; 0 means the whole half-width is linear. */
  k: number;
  /** Scale of the tails, Hz: distance = coreHz + b·(e^{k(u−core)} − 1). */
  b: number;
  /** Distance from the focus to the farther window edge, Hz (reached at the side edges). */
  reachHz: number;
}

export interface FrequencyScale {
  lowHz: number;
  spanHz: number;
  lens: LensShape | null;
  /** Position 0..1 across the width; outside 0..1 when off screen. */
  x(hz: number): number;
  /** Frequency at a position 0..1 (may fall outside the receiver window under a lens). */
  hz(x: number): number;
  /** Hz per unit of width at a position, for hit tolerances. */
  hzPerWidth(x: number): number;
}

export function linearScale(lowHz: number, spanHz: number): FrequencyScale {
  return {
    lowHz, spanHz, lens: null,
    x: (hz) => (hz - lowHz) / spanHz,
    hz: (x) => lowHz + x * spanHz,
    hzPerWidth: () => spanHz,
  };
}

/** Tail growth k so that the tail reaches `reach` at the edge with the core's slope at the seam. */
function solveGrowth(coreHz: number, core: number, reachHz: number): number {
  // f(k) = coreHz/(core·k)·(e^{k(1−core)} − 1) − (reach − coreHz), increasing in k, f(0+) = coreHz/core − reach.
  const f = (k: number) => coreHz / (core * k) * Math.expm1(k * (1 - core)) - (reachHz - coreHz);
  let lo = 1e-9;
  let hi = 1;
  while (f(hi) < 0 && hi < 1e4) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function lensShape(lowHz: number, spanHz: number, focusHz: number,
  coreHz = LENS_CORE_HZ, coreFraction = LENS_CORE_FRACTION): LensShape {
  const reachHz = Math.max(focusHz - lowHz, lowHz + spanHz - focusHz, coreHz);
  // A window too narrow to need a lens: one linear scale across the half-width.
  if (reachHz <= coreHz / coreFraction) return { focusHz, coreHz: reachHz, core: 1, k: 0, b: 0, reachHz };
  const k = solveGrowth(coreHz, coreFraction, reachHz);
  return { focusHz, coreHz, core: coreFraction, k, b: coreHz / (coreFraction * k), reachHz };
}

/** Distance from the focus (Hz) at half-width position u (0 = middle, 1 = side edge). */
export function lensDistance(shape: LensShape, u: number): number {
  if (u <= shape.core) return shape.coreHz * u / shape.core;
  return shape.coreHz + shape.b * Math.expm1(shape.k * (u - shape.core));
}

/** Inverse of lensDistance. */
export function lensPosition(shape: LensShape, distanceHz: number): number {
  if (distanceHz <= shape.coreHz) return distanceHz / shape.coreHz * shape.core;
  return shape.core + Math.log1p((distanceHz - shape.coreHz) / shape.b) / shape.k;
}

export function lensScale(lowHz: number, spanHz: number, focusHz: number): FrequencyScale {
  const lens = lensShape(lowHz, spanHz, focusHz);
  return {
    lowHz, spanHz, lens,
    x: (hz) => 0.5 + Math.sign(hz - focusHz) * lensPosition(lens, Math.abs(hz - focusHz)) / 2,
    hz: (x) => focusHz + Math.sign(x - 0.5) * lensDistance(lens, Math.abs(x - 0.5) * 2),
    hzPerWidth: (x) => {
      const u = Math.abs(x - 0.5) * 2;
      const slope = u <= lens.core ? lens.coreHz / lens.core : lens.b * lens.k * Math.exp(lens.k * (u - lens.core));
      return 2 * slope;
    },
  };
}

export interface ScaleTick { x: number; label: string | null; major: boolean }

const OFFSETS = [5e3, 10e3, 15e3, 20e3, 50e3, 100e3, 200e3, 500e3, 1e6, 2e6, 5e6, 10e6, 20e6, 50e6];
const MAJOR = new Set([20e3, 100e3, 1e6, 10e6]);

function offsetLabel(hz: number) {
  return hz >= 1e6 ? `${hz / 1e6}M` : `${hz / 1e3}k`;
}

/**
 * Log-paper ticks for a lens, as on the K6's SURF screen: offsets from the focus, every
 * 5 kHz in the core, then 1-2-5 steps, labelled at 20 kHz, 100 kHz, 1 MHz and 10 MHz.
 * Ticks closer than `minPx` to the previous one on their side are dropped, and so are
 * labels closer than `labelPx`.
 */
export function lensTicks(scale: FrequencyScale, widthPx: number, minPx = 6, labelPx = 44): ScaleTick[] {
  const lens = scale.lens;
  if (!lens || widthPx <= 0) return [];
  const high = scale.lowHz + scale.spanHz;
  const ticks: ScaleTick[] = [];
  for (const side of [-1, 1]) {
    let lastX = 0.5;
    let lastLabel = 0.5;
    for (const offset of OFFSETS) {
      const hz = lens.focusHz + side * offset;
      if (offset > lens.reachHz || hz < scale.lowHz || hz > high) break;
      const x = scale.x(hz);
      if (Math.abs(x - lastX) * widthPx < minPx) continue;
      lastX = x;
      const labelled = MAJOR.has(offset) && Math.abs(x - lastLabel) * widthPx >= labelPx;
      if (labelled) lastLabel = x;
      ticks.push({ x, major: MAJOR.has(offset), label: labelled ? `${side < 0 ? "−" : "+"}${offsetLabel(offset)}` : null });
    }
  }
  return ticks.sort((a, b) => a.x - b.x);
}

/** Uniform values for the renderer: everything in units of the window span from its low edge. */
export interface LensUniforms {
  focus: number;
  coreSpan: number;
  core: number;
  k: number;
  b: number;
}

export function lensUniforms(scale: FrequencyScale): LensUniforms | null {
  const lens = scale.lens;
  if (!lens) return null;
  return {
    focus: (lens.focusHz - scale.lowHz) / scale.spanHz,
    coreSpan: lens.coreHz / scale.spanHz,
    core: lens.core,
    k: lens.k,
    b: lens.b / scale.spanHz,
  };
}
