/** Typing a frequency outside the receiver window moves the window there first. */

/** Keep a tuned frequency this far inside the window's edges (the RF filter rolls off there). */
export const EDGE_MARGIN_HZ = 1_000_000;
/** Put the new LO this far below the target, so the target never sits on the LO's DC spur. */
export const LO_OFFSET_HZ = 1_000_000;

export interface Window {
  centerHz: number;
  widthHz: number;
}

/** True when `hz` can be heard without moving the window. */
export function inWindow(hz: number, w: Window): boolean {
  return Math.abs(hz - w.centerHz) <= w.widthHz / 2 - EDGE_MARGIN_HZ;
}

/** The window center to move to for `hz`: 1 MHz below it, on a 100 kHz step. */
export function centerFor(hz: number): number {
  return Math.round((hz - LO_OFFSET_HZ) / 100_000) * 100_000;
}
