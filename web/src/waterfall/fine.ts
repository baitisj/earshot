import { useEffect, useRef } from "react";
import type { FineSpectrum } from "@/backend/types";
import { useBackend } from "@/state/radio";
import { onSpectrumRows, spectrumRows } from "./feed";

/**
 * Fine rows (the listened channel's IQ, ~98 Hz bins) for the waterfall lens. Pulls after
 * each waterfall batch while enabled, so every fine row lands beside the waterfall row of
 * the same moment. `onBatch(null)` means there is no fine data (nothing listened, an older
 * engine, or the channel's IQ is not buffered).
 */
/** Why there is no fine batch: lens off or nothing listened, the engine has no IQ for the channel, or the request failed. */
export type FineMiss = "off" | "missing" | "failed";

export function useFineSpectrum(channelId: string | null, enabled: boolean, onBatch: (batch: FineSpectrum | null, miss?: FineMiss) => void) {
  const backend = useBackend();
  const callback = useRef(onBatch);
  useEffect(() => {
    callback.current = onBatch;
  });
  useEffect(() => {
    const emit = (batch: FineSpectrum | null, miss?: FineMiss) => callback.current(batch, miss);
    if (!enabled || !channelId || !backend.fineSpectrum) {
      emit(null, "off");
      return;
    }
    let after = Math.max(0, (spectrumRows[0]?.sequence ?? 1) - 1);
    let busy = false;
    let again = false;
    let disposed = false;
    let missedAt = -Infinity;
    const pull = async () => {
      if (disposed || document.visibilityState === "hidden") return;
      if (busy) {
        again = true;
        return;
      }
      // After a miss, ask at most once a second.
      if (performance.now() - missedAt < 1000) return;
      busy = true;
      try {
        const batch = await backend.fineSpectrum!(channelId, after);
        if (disposed) return;
        if (!batch) {
          missedAt = performance.now();
          emit(null, "missing");
          return;
        }
        // Moments up to the engine's newest sequence are done, with or without IQ behind them;
        // a smaller sequence means the engine restarted.
        after = batch.sequence;
        emit(batch);
      } catch (error) {
        missedAt = performance.now();
        console.debug("fine spectrum", channelId, error);
        emit(null, "failed");
      } finally {
        busy = false;
        if (again && !disposed) {
          again = false;
          void pull();
        }
      }
    };
    void pull();
    const unsubscribe = onSpectrumRows(() => void pull());
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [backend, channelId, enabled]);
}
