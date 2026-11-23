import { ChannelIdentity } from "@/components/ChannelIdentity";
import type { Passband } from "@/components/passband";
import { pickSignal, type WaterfallPick } from "@/waterfall/pick";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatMHz } from "@/domain/adapt";
import type { Source } from "@/domain/model";
import { cn } from "@/lib/utils";
import { createRenderer, type Renderer } from "@/waterfall/renderer";
import { onSpectrumRows, spectrumRows, useSpectrumMeta } from "@/waterfall/feed";
import { historyTicks, lineTimes, rowForLine, speedGeometry, speedLabel } from "@/waterfall/ticks";
import { LENS_CORE_HZ, lensScale, lensTicks, lensUniforms, linearScale } from "@/waterfall/lens";
import { useFineSpectrum } from "@/waterfall/fine";
import { prefs, usePrefs } from "@/state/prefs";

interface Props {
  variant: "strip" | "full";
  /** Sources to mark. The strip gets only who's talking and what's playing. */
  sources: Source[];
  /** Smoothed talking state from the home model (domain/calm.ts). */
  talking: ReadonlyMap<string, number>;
  activeSourceId: string | null;
  tunedFrequencyHz?: number | null;
  /** Full view only: tapping a marked trace listens to it. */
  onListen?(source: Source): void;
  /** Full view only: tapped a trace with no source nearby. */
  onUnnamed?(frequencyHz: number): void;
  captureRange?: { centerHz: number; spanHz: number } | null;
  /** Full view: the listened channel, whose IQ gives the lens its fine detail. */
  iqChannelId?: string | null;
  /** Full view: the demodulator's passband around the tuned line and the cursor. */
  passband?: Passband | null;
  className?: string;
}

const HIT_PX = 22;

export function Waterfall({ variant, sources, talking, activeSourceId, tunedFrequencyHz, onListen, onUnnamed, captureRange, iqChannelId, passband, className }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ pointerId: number; lastTune: number; frequency: number | null } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const meta = useSpectrumMeta();
  // Bumped when the GPU context is restored after the browser dropped it (common on backgrounded phones).
  const [contextEpoch, setContextEpoch] = useState(0);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [hover, setHover] = useState<WaterfallPick | null>(null);
  const speed = usePrefs().waterfallSpeed;
  // The strip keeps its own fixed pace; the speed slider is the full view's.
  const { group, lines: visible } = speedGeometry(variant === "full" ? speed : 0, variant === "strip" ? 60 : 300);
  const renderer = useRef<Renderer | null>(null);
  const redraw = useRef(() => {});
  const lensOn = usePrefs().lens && variant === "full";
  const [fineLive, setFineLive] = useState(false);

  const low = meta.centerHz !== null && meta.spanHz !== null ? meta.centerHz - meta.spanHz / 2 : null;
  const inWindow = (hz: number | null | undefined): hz is number =>
    hz != null && low !== null && meta.spanHz !== null && hz >= low && hz <= low + meta.spanHz;
  const focusHz = inWindow(tunedFrequencyHz) ? tunedFrequencyHz : meta.centerHz;
  const scale = useMemo(() => {
    if (low === null || !meta.spanHz) return null;
    return lensOn && focusHz !== null ? lensScale(low, meta.spanHz, focusHz) : linearScale(low, meta.spanHz);
  }, [low, meta.spanHz, lensOn, focusHz]);
  const uniforms = useMemo(() => (scale ? lensUniforms(scale) : null), [scale]);
  const uniformsRef = useRef(uniforms);
  // A hover line placed on the old scale would point at the wrong frequency.
  useEffect(() => setHover(null), [scale]);
  useEffect(() => {
    uniformsRef.current = uniforms;
    renderer.current?.setLens(uniforms);
    redraw.current();
  }, [uniforms]);

  useFineSpectrum(lensOn ? iqChannelId ?? null : null, lensOn, (batch) => {
    const r = renderer.current;
    setFineLive(!!batch);
    if (!r) return;
    if (!batch || low === null || !meta.spanHz) {
      r.setFine(null);
    } else {
      r.setFine({ center: (batch.centerHz - low) / meta.spanHz, width: batch.rateHz / meta.spanHz, reach: LENS_CORE_HZ / meta.spanHz, bins: batch.bins });
      batch.rows.forEach((row) => r.pushFine(row.sequence, row.bins));
    }
    redraw.current();
  });

  useEffect(() => {
    const el = canvas.current;
    if (!el || !meta.bins) return;
    let r: Renderer;
    try {
      r = createRenderer(el, { bins: meta.bins, capacity: 512, visible, smoothing: 1, group });
    } catch {
      return;
    }
    spectrumRows.slice(-(visible + 1) * group).forEach((row) => r.push(row.bins, row.sequence));
    r.setLens(uniformsRef.current);
    renderer.current = r;
    let frame = 0;
    let dirty = true;
    redraw.current = () => { dirty = true; };
    const draw = () => {
      if (dirty) {
        r.draw();
        dirty = false;
      }
      frame = requestAnimationFrame(draw);
    };
    const resize = () => {
      const rect = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      r.resize(Math.max(1, Math.round(rect.width * dpr)), Math.max(1, Math.round(rect.height * dpr)));
      setWidth(rect.width);
      setHeight(rect.height);
      dirty = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    const unsubscribe = onSpectrumRows((rows) => {
      rows.forEach((row) => r.push(row.bins, row.sequence));
      dirty = true;
    });
    frame = requestAnimationFrame(draw);
    const lost = (event: Event) => {
      event.preventDefault();
      cancelAnimationFrame(frame);
    };
    const restored = () => setContextEpoch((n) => n + 1);
    el.addEventListener("webglcontextlost", lost);
    el.addEventListener("webglcontextrestored", restored);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      el.removeEventListener("webglcontextlost", lost);
      el.removeEventListener("webglcontextrestored", restored);
      if (renderer.current === r) renderer.current = null;
      redraw.current = () => {};
      r.dispose();
    };
  }, [meta.bins, meta.epoch, visible, group, contextEpoch]);

  const markers = useMemo(() => {
    if (!scale) return [];
    // Both TDMA slots and raw/unknown aliases occupy the same RF trace.
    const unique = new Map<number, Source>();
    const rank = (s: Source) => Number(s.id === activeSourceId) * 8 + Number(talking.has(s.id)) * 4 + Number(s.named) * 2 + Number(s.heardVoice);
    for (const source of sources) {
      if (source.frequencyHz === null || !source.inRange) continue;
      const hz = Math.round(source.frequencyHz);
      const existing = unique.get(hz);
      if (!existing || rank(source) > rank(existing)) unique.set(hz, source);
    }
    return [...unique.values()]
      .map((s) => ({ source: s, x: scale.x(s.frequencyHz!), live: talking.has(s.id) }))
      .filter((m) => m.x >= 0 && m.x <= 1);
  }, [sources, talking, scale, activeSourceId]);

  const positionAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    return rect ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : null;
  };
  const frequencyAt = (clientX: number) => {
    const x = positionAt(clientX);
    if (x === null || !scale) return null;
    // Under a lens the side past the nearer window edge is blank: pick its edge.
    return Math.max(scale.lowHz, Math.min(scale.lowHz + scale.spanHz, scale.hz(x)));
  };

  const interactive = variant === "full" && (!!onListen || !!onUnnamed);
  const targetAt = (clientX: number, clientY: number, exact: boolean) => {
    const rect = box.current?.getBoundingClientRect();
    const frequency = frequencyAt(clientX);
    const x = positionAt(clientX);
    if (!rect || frequency === null || x === null || !scale || low === null || !meta.spanHz) return null;
    const row = Math.floor(Math.max(0, Math.min(0.999, (clientY - rect.top) / rect.height)) * visible);
    // Inside the lens core one wideband bin covers the whole core, so don't snap to its peak.
    const inCore = scale.lens !== null && Math.abs(frequency - scale.lens.focusHz) <= scale.lens.coreHz;
    const bins = inCore ? undefined : spectrumRows[rowForLine(spectrumRows, group, row)]?.bins;
    return pickSignal(frequency, HIT_PX / rect.width * scale.hzPerWidth(x), low, meta.spanHz, bins, sources, exact);
  };
  const pick = (clientX: number, clientY: number, exact: boolean) => {
    const target = targetAt(clientX, clientY, exact);
    if (!target) return;
    if (drag.current?.frequency === target.frequencyHz) return;
    if (drag.current) { drag.current.frequency = target.frequencyHz; drag.current.lastTune = performance.now(); }
    if (target.source) onListen?.(target.source);
    else onUnnamed?.(target.frequencyHz);
  };

  const empty = !meta.bins;
  const stale = !empty && Date.now() - meta.receivedAt > 10_000;

  const tickCount = Math.max(2, Math.floor(width / 110));
  const rawStep = (meta.spanHz ?? 1) / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const tickStep = [1, 2, 5, 10].find((n) => n * magnitude >= rawStep)! * magnitude;
  const frequencyTicks: number[] = [];
  if (low !== null && meta.spanHz && !scale?.lens) {
    for (let hz = Math.ceil(low / tickStep) * tickStep; hz <= low + meta.spanHz; hz += tickStep)
      frequencyTicks.push(hz);
  }
  const timeTicks = historyTicks(lineTimes(spectrumRows, group, visible), visible, height);

  return (
    <div className={cn("flex flex-col overflow-hidden bg-[#0f1a2b]", variant === "strip" ? "h-14 rounded-lg" : "h-full min-h-40 rounded-xl", className)}>
      {variant === "full" && low !== null && meta.spanHz && (
        <div aria-label="Frequency scale (MHz)" className="relative h-7 shrink-0 border-b border-[#93a1b8]/30 text-[11px] text-[#c9d4e5]">
          {frequencyTicks.map((hz) => (
            <span key={hz} className="absolute bottom-0 h-2 border-l border-[#93a1b8]/60" style={{ left: `${(hz - low) / meta.spanHz! * 100}%` }}>
              <span className="absolute bottom-2 -translate-x-1/2 whitespace-nowrap">{(hz / 1e6).toFixed(Math.max(0, Math.ceil(6 - Math.log10(tickStep))))}</span>
            </span>
          ))}
          {scale?.lens && lensTicks(scale, width).map((tick) => (
            <span key={tick.x} className={cn("absolute bottom-0 border-l", tick.major ? "h-2 border-[#93a1b8]/80" : "h-1 border-[#93a1b8]/50")} style={{ left: `${tick.x * 100}%` }}>
              {tick.label && <span className="absolute bottom-2 -translate-x-1/2 whitespace-nowrap">{tick.label}</span>}
            </span>
          ))}
          {scale?.lens && (
            <span className="tabular absolute bottom-2 left-1/2 -translate-x-1/2 bg-[#0f1a2b] px-1 text-[#f2f5fa]">{(scale.lens.focusHz / 1e6).toFixed(4)}</span>
          )}
          <button type="button" aria-pressed={lensOn} title="Lens: ±20 kHz around the tuned frequency, log scale beyond"
            className={cn("absolute top-0 left-1 rounded px-1.5 leading-5", lensOn ? "bg-[#5eb8c9] text-[#0f1a2b]" : "bg-[#0f1a2b] text-[#c9d4e5] hover:bg-white/10")}
            onClick={() => prefs.set("lens", !lensOn)}>Lens</button>
          <label className="absolute top-0 left-14 flex h-5 items-center gap-1 rounded bg-[#0f1a2b] px-1" title="Waterfall speed: slower averages rows into each line, faster draws taller lines">
            <span>Speed</span>
            <input type="range" min={-3} max={2} step={1} value={speed} aria-valuetext={speedLabel(speed)}
              className="h-1 w-20 accent-[#5eb8c9]" onChange={(e) => prefs.set("waterfallSpeed", Number(e.target.value))} />
            <span className="tabular w-8">{speedLabel(speed)}</span>
          </label>
          <span className="absolute top-0 right-1 bg-[#0f1a2b] px-1">MHz</span>
        </div>
      )}
    <div
      ref={box}
      className={cn(
        "relative overflow-hidden bg-[#0f1a2b] select-none",
        "min-h-0 flex-1", interactive && "touch-none cursor-crosshair",
      )}
      onPointerDown={interactive ? (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { pointerId: e.pointerId, lastTune: 0, frequency: null };
        setHover(targetAt(e.clientX, e.clientY, e.shiftKey));
        pick(e.clientX, e.clientY, e.shiftKey);
      } : undefined}
      onPointerMove={interactive ? (e) => {
        setHover(targetAt(e.clientX, e.clientY, e.shiftKey));
        // Under the lens the scale re-centres on each tune, so dragging would chase itself.
        if (!lensOn && drag.current?.pointerId === e.pointerId && performance.now() - drag.current.lastTune >= 120)
          pick(e.clientX, e.clientY, e.shiftKey);
      } : undefined}
      onPointerUp={interactive ? (e) => {
        if (drag.current?.pointerId !== e.pointerId) return;
        // Under the lens the press already tuned and re-centred the scale, so the same
        // screen position now means another frequency: tune once per press.
        if (!lensOn) pick(e.clientX, e.clientY, e.shiftKey);
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      } : undefined}
      onPointerCancel={interactive ? () => { drag.current = null; setHover(null); } : undefined}
      onLostPointerCapture={interactive ? () => { drag.current = null; } : undefined}
      onPointerLeave={interactive ? () => { if (!drag.current) setHover(null); } : undefined}
      role="img"
      aria-label={
        empty
          ? "Live airwaves: no data yet"
          : `Live airwaves, ${formatMHz(low ?? 0, 1)} to ${formatMHz((low ?? 0) + (meta.spanHz ?? 0), 1)} MHz`
      }
      data-waterfall={variant}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden />
      {variant === "full" && timeTicks.map(({ row, ageSeconds }) => (
        <span key={row} aria-hidden className="pointer-events-none absolute left-0 border-t border-white/30 bg-[#0f1a2b]/80 px-1 text-[10px] text-[#c9d4e5]" style={{ top: `${row / visible * 100}%` }}>
          {ageSeconds === 0 ? "Newest" : `−${ageSeconds} s`}
        </span>
      ))}
      {variant === "full" && meta.bins > 0 && meta.spanHz && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-[#0f1a2b]/85 px-1 text-[10px] text-[#c9d4e5]">{lensOn
          ? fineLive ? "Lens ±20 kHz · 98 Hz bins" : `Lens ±20 kHz · ${(meta.spanHz / meta.bins / 1000).toFixed(0)} kHz bins (listen for detail)`
          : `${(meta.spanHz / meta.bins / 1000).toFixed(2)} kHz/bin`}</span>
      )}
      {empty && (
        <p className="absolute inset-0 grid place-items-center px-4 text-center text-xs text-[#93a1b8]">
          No signal
        </p>
      )}
      {stale && (
        <p className="absolute right-2 bottom-1 rounded bg-[#0f1a2b]/80 px-1.5 text-[11px] text-[#93a1b8]">Paused</p>
      )}
      {width > 0 &&
        markers.filter(({ source }) => source.id === activeSourceId).map(({ source, x, live }) => (
          <span
            key={source.id}
            aria-hidden
            className={cn(
              "pointer-events-none absolute w-0.5 -translate-x-1/2 rounded-full",
              // On the strip, a marked trace gets a full-height guide line so the label points at it.
              variant === "strip" ? "inset-y-0 opacity-80" : "top-0 h-2.5",
              live ? "bg-[#f5a524]" : "bg-[#93a1b8]/60",
              source.id === activeSourceId && "w-1 bg-[#5eb8c9]",
            )}
            style={{ left: `${x * 100}%` }}
          />
        ))}
      {captureRange && scale && (
        <span aria-hidden data-iq-range className="pointer-events-none absolute inset-y-0 border-x border-[#5eb8c9]/90 bg-[#5eb8c9]/15"
          style={captureStyle(captureRange, scale!)} />
      )}
      {variant === "full" && tunedFrequencyHz != null && low !== null && meta.spanHz && tunedFrequencyHz >= low && tunedFrequencyHz <= low + meta.spanHz && (
        <>
          {passband && <span aria-hidden data-passband="tuned" className="pointer-events-none absolute inset-y-0 border-x border-[#5eb8c9]/60 bg-[#5eb8c9]/10" style={bandStyle(tunedFrequencyHz, passband, scale!)} />}
          <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-[#5eb8c9]" style={{ left: `${scale!.x(tunedFrequencyHz) * 100}%` }} />
        </>
      )}
      {variant === "full" && hover !== null && low !== null && meta.spanHz && (
        <>
          {passband && <span aria-hidden data-passband="cursor" className="pointer-events-none absolute inset-y-0 border-x border-dashed border-white/50 bg-white/5" style={bandStyle(hover.frequencyHz, passband, scale!)} />}
          <span aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-white/70" style={{ left: `${scale!.x(hover.frequencyHz) * 100}%` }} />
        </>
      )}
      {variant === "full" && hover !== null && (
        <span className="tabular pointer-events-none absolute bottom-2 left-2 rounded bg-[#0f1a2b]/85 px-1.5 py-0.5 text-xs text-[#f2f5fa]">
          {hover.snapped ? "Snap to " : "Tune "}<ChannelIdentity name={hover.source?.name} frequencyHz={hover.frequencyHz} mode={hover.source?.mode} slot={hover.source?.slot} compact />
        </span>
      )}
    </div>
    </div>
  );
}

/** A passband around a frequency on screen; at least 3 px wide so it shows on a wide window. */
function bandStyle(hz: number, band: Passband, scale: { x(hz: number): number }) {
  const left = scale.x(hz + band.lowHz);
  const right = scale.x(hz + band.highHz);
  return { left: `${left * 100}%`, width: `max(3px, ${Math.max(0, right - left) * 100}%)` };
}

/** The capture range's band on screen, clipped to the window (and to the screen under a lens). */
function captureStyle(range: { centerHz: number; spanHz: number }, scale: { lowHz: number; spanHz: number; x(hz: number): number }) {
  const lo = Math.max(scale.lowHz, range.centerHz - range.spanHz / 2);
  const hi = Math.min(scale.lowHz + scale.spanHz, range.centerHz + range.spanHz / 2);
  const left = Math.max(0, Math.min(1, scale.x(lo)));
  const right = Math.max(0, Math.min(1, scale.x(hi)));
  return { left: `${left * 100}%`, width: `${Math.max(0, right - left) * 100}%` };
}
