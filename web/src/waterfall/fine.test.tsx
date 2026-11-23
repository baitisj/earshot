import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const fineSpectrum = vi.fn();
const backend = { fineSpectrum };
vi.mock("@/state/radio", () => ({ useBackend: () => backend }));
const listeners = new Set<() => void>();
vi.mock("./feed", () => ({
  spectrumRows: [{ sequence: 50 }],
  onSpectrumRows: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); },
}));

import { useFineSpectrum } from "./fine";

function batch(seq: number) {
  return { bins: 4, rows: [], centerHz: 0, rateHz: 1, lowDb: -160, highDb: 0, sequence: seq };
}

describe("useFineSpectrum", () => {
  it("recovers after the new channel's IQ is not buffered yet", async () => {
    vi.useFakeTimers();
    let calls = 0;
    fineSpectrum.mockImplementation(async () => (++calls <= 2 ? null : batch(100 + calls)));
    const seen: string[] = [];
    const { rerender } = renderHook(({ id }) => useFineSpectrum(id, true, (b) => seen.push(b ? "batch" : "null")), { initialProps: { id: "a" as string | null } });
    rerender({ id: null });
    rerender({ id: "b" });
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        vi.advanceTimersByTime(100);
        listeners.forEach((l) => l());
      });
    }
    vi.useRealTimers();
    expect(seen.at(-1)).toBe("batch");
  });
});
