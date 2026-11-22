import { COLORMAP } from "./colormap";
import type { LensUniforms } from "./lens";

/**
 * Waterfall renderer. Rows go into a ring texture (one row per spectrum line,
 * newest at the top); the colormap is a lookup texture applied in the shader.
 * Native bins and rows are drawn without interpolation or temporal smearing. Falls back to
 * a 2D canvas when WebGL2 is unavailable.
 */
/** Where the fine rows sit, in units of the window span from its low edge. */
export interface FineGeometry {
  /** Physical center of the fine slice. */
  center: number;
  /** Its sample rate: the rows span center ± width/2. */
  width: number;
  /** Fine data is drawn only within this distance of the lens focus (the core). */
  reach: number;
  /** Bins per row. */
  bins: number;
}

export interface Renderer {
  /** A waterfall row; `sequence` lets fine rows for the same moment find it. */
  push(row: Uint8Array, sequence?: number): void;
  /** A fine row for the waterfall row with this sequence (ignored once it has scrolled away). */
  pushFine(sequence: number, row: Uint8Array): void;
  /** Lens warp, or null for the linear scale. */
  setLens(lens: LensUniforms | null): void;
  setFine(geometry: FineGeometry | null): void;
  resize(width: number, height: number): void;
  draw(): void;
  dispose(): void;
}

const VERTEX = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D rows;
uniform sampler2D colormap;
uniform sampler2D fine;
uniform float newest;
uniform float visible;
uniform float capacity;
uniform float floorLevel;
uniform float ceilLevel;
uniform int lensOn;
uniform float focus;
uniform float coreSpan;
uniform float coreFrac;
uniform float growth;
uniform float tailScale;
uniform int fineOn;
uniform float fineCenter;
uniform float fineWidth;
uniform float fineReach;
uniform float fineFloor;
uniform float fineCeil;
out vec4 color;
// Window position (0..1 of the span) shown at screen position x; see lens.ts.
float windowAt(float x) {
  if (lensOn == 0) return x;
  float u = abs(x - 0.5) * 2.0;
  float d = u <= coreFrac ? coreSpan * u / coreFrac : coreSpan + tailScale * (exp(growth * (u - coreFrac)) - 1.0);
  return focus + sign(x - 0.5) * d;
}
vec4 shade(float v, float lo, float hi) {
  return texture(colormap, vec2(clamp((v - lo) / max(0.02, hi - lo), 0.0, 1.0), 0.5));
}
void main() {
  float f = windowAt(uv.x);
  if (f < 0.0 || f > 1.0) { color = vec4(0.059, 0.102, 0.169, 1.0); return; }
  float r = mod(newest - floor(uv.y * visible) + capacity, capacity);
  float t = (r + 0.5) / capacity;
  if (fineOn == 1 && abs(f - focus) <= fineReach) {
    float fu = 0.5 + (f - fineCenter) / fineWidth;
    // Only the slice's flat middle (±35 of ±50 kHz); past it the channelizer rolls off.
    if (fu >= 0.15 && fu <= 0.85) {
      float v = texture(fine, vec2(fu, t)).r;
      if (v > 0.0) { color = shade(v, fineFloor, fineCeil); return; }
    }
  }
  color = shade(texture(rows, vec2(f, t)).r, floorLevel, ceilLevel);
}`;

export interface RendererOptions {
  bins: number;
  /** Rows kept in the ring (history height). */
  capacity: number;
  /** Rows shown; ≤ capacity. */
  visible: number;
  /** EMA weight of the newest row, 0..1 (1 = no averaging). */
  smoothing?: number;
  /** Waterfall rows averaged into each screen line (1 = every row its own line). Rows are
   * grouped by sequence (floor(sequence / group)), so a replay groups them the same way. */
  group?: number;
}

/** Running mean of the rows that share one screen line. */
class LineMean {
  private sum: Float32Array | null = null;
  private count = 0;
  key = NaN;
  start(key: number, row: Uint8Array) {
    this.key = key;
    this.sum = Float32Array.from(row);
    this.count = 1;
    return row;
  }
  add(row: Uint8Array): Uint8Array {
    const sum = this.sum!;
    this.count++;
    const out = new Uint8Array(row.length);
    for (let i = 0; i < row.length; i++) {
      sum[i] += row[i];
      out[i] = Math.round(sum[i] / this.count);
    }
    return out;
  }
}

/** Screen-line key for a row: rows with the same key share a line. */
function lineKey(sequence: number | undefined, group: number) {
  return group > 1 && sequence !== undefined ? Math.floor(sequence / group) : NaN;
}

/** Noise floor and peak estimates so the colormap adapts to the data. */
class Levels {
  floor = 0.25;
  ceil = 0.85;
  private seeded = false;
  update(row: Uint8Array) {
    const sorted = Array.from(row).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.2)] / 255 - 0.01;
    const ceil = Math.max(floor + 0.12, sorted[sorted.length - 1] / 255);
    if (!this.seeded) {
      this.floor = floor;
      this.ceil = ceil;
      this.seeded = true;
      return;
    }
    this.floor = this.floor * 0.9 + floor * 0.1;
    this.ceil = this.ceil * 0.97 + Math.max(this.floor + 0.12, ceil) * 0.03;
  }
}

class Smoother {
  private state: Float32Array | null = null;
  private alpha: number;

  constructor(alpha: number) {
    this.alpha = alpha;
  }
  apply(row: Uint8Array): Uint8Array {
    if (this.alpha >= 1) return row;
    if (!this.state || this.state.length !== row.length) this.state = Float32Array.from(row);
    const out = new Uint8Array(row.length);
    for (let i = 0; i < row.length; i++) {
      this.state[i] += (row[i] - this.state[i]) * this.alpha;
      out[i] = this.state[i];
    }
    return out;
  }
}

export function createRenderer(canvas: HTMLCanvasElement, options: RendererOptions): Renderer {
  const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false });
  return gl ? webgl(canvas, gl, options) : canvas2d(canvas, options);
}

function webgl(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, o: RendererOptions): Renderer {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const rows = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, rows);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, o.bins, o.capacity, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(o.bins * o.capacity));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  const lut = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, lut);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, COLORMAP);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);

  let fine: WebGLTexture | null = null;
  let fineBins = 0;
  const allocFine = (bins: number) => {
    if (fine && fineBins === bins) return;
    if (fine) gl.deleteTexture(fine);
    fine = gl.createTexture();
    fineBins = bins;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fine);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, bins, o.capacity, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(bins * o.capacity));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  };
  allocFine(1);

  const u = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform1i(u("rows"), 0);
  gl.uniform1i(u("colormap"), 1);
  gl.uniform1i(u("fine"), 2);
  gl.uniform1i(u("lensOn"), 0);
  gl.uniform1i(u("fineOn"), 0);
  gl.uniform1f(u("capacity"), o.capacity);
  gl.uniform1f(u("visible"), o.visible);

  let newest = 0;
  const levels = new Levels();
  const fineLevels = new Levels();
  const smoother = new Smoother(o.smoothing ?? 1);
  // Waterfall sequences held in each ring slot, so a fine row lands beside its moment.
  const group = Math.max(1, Math.round(o.group ?? 1));
  const slotFirst = new Float64Array(o.capacity).fill(-1);
  const slotLast = new Float64Array(o.capacity).fill(-1);
  const line = new LineMean();
  // CPU copy of the fine rows, to average the fine rows that share a line.
  let fineSum = new Float32Array(0);
  const fineCount = new Uint16Array(o.capacity);
  let blank = new Uint8Array(fineBins);
  let fineOn = false;
  return {
    push(row, sequence) {
      if (row.length !== o.bins) return;
      const smoothed = smoother.apply(row);
      const key = lineKey(sequence, group);
      let shown: Uint8Array;
      if (!Number.isNaN(key) && key === line.key) {
        shown = line.add(smoothed);
      } else {
        shown = line.start(key, smoothed);
        newest = (newest + 1) % o.capacity;
        slotFirst[newest] = sequence ?? -1;
        fineCount[newest] = 0;
        // The slot's old fine row belongs to a moment long gone: 0 means "no fine data".
        if (blank.length !== fineBins) blank = new Uint8Array(fineBins);
        gl.activeTexture(gl.TEXTURE2);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, newest, fineBins, 1, gl.RED, gl.UNSIGNED_BYTE, blank);
      }
      slotLast[newest] = sequence ?? -1;
      levels.update(shown);
      gl.activeTexture(gl.TEXTURE0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, newest, o.bins, 1, gl.RED, gl.UNSIGNED_BYTE, shown);
    },
    pushFine(sequence, row) {
      if (!fineOn || row.length !== fineBins) return;
      for (let i = 0; i < o.capacity; i++) {
        const slot = (newest - i + o.capacity) % o.capacity;
        if (slotFirst[slot] < 0 || sequence < slotFirst[slot] || sequence > slotLast[slot]) continue;
        if (fineSum.length !== o.capacity * fineBins) fineSum = new Float32Array(o.capacity * fineBins);
        const sum = fineSum.subarray(slot * fineBins, (slot + 1) * fineBins);
        if (fineCount[slot] === 0) sum.fill(0);
        const count = ++fineCount[slot];
        const shown = new Uint8Array(fineBins);
        for (let b = 0; b < fineBins; b++) {
          sum[b] += row[b];
          shown[b] = Math.max(1, Math.round(sum[b] / count));
        }
        fineLevels.update(shown);
        gl.activeTexture(gl.TEXTURE2);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, slot, fineBins, 1, gl.RED, gl.UNSIGNED_BYTE, shown);
        return;
      }
    },
    setLens(lens) {
      gl.uniform1i(u("lensOn"), lens ? 1 : 0);
      if (!lens) return;
      gl.uniform1f(u("focus"), lens.focus);
      gl.uniform1f(u("coreSpan"), lens.coreSpan);
      gl.uniform1f(u("coreFrac"), lens.core);
      gl.uniform1f(u("growth"), lens.k);
      gl.uniform1f(u("tailScale"), lens.b);
    },
    setFine(geometry) {
      fineOn = !!geometry;
      gl.uniform1i(u("fineOn"), geometry ? 1 : 0);
      if (!geometry) return;
      if (geometry.bins !== fineBins) {
        allocFine(geometry.bins);
        blank = new Uint8Array(fineBins);
      }
      gl.uniform1f(u("fineCenter"), geometry.center);
      gl.uniform1f(u("fineWidth"), geometry.width);
      gl.uniform1f(u("fineReach"), geometry.reach);
    },
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    },
    draw() {
      gl.uniform1f(u("newest"), newest);
      gl.uniform1f(u("floorLevel"), levels.floor);
      gl.uniform1f(u("ceilLevel"), levels.ceil);
      gl.uniform1f(u("fineFloor"), fineLevels.floor);
      gl.uniform1f(u("fineCeil"), fineLevels.ceil);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl.deleteTexture(rows);
      gl.deleteTexture(lut);
      if (fine) gl.deleteTexture(fine);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

function canvas2d(canvas: HTMLCanvasElement, o: RendererOptions): Renderer {
  const ctx = canvas.getContext("2d");
  const history: Uint8Array[] = [];
  const levels = new Levels();
  const smoother = new Smoother(o.smoothing ?? 1);
  const group = Math.max(1, Math.round(o.group ?? 1));
  const line = new LineMean();
  let lens: LensUniforms | null = null;
  return {
    push(row, sequence) {
      const smoothed = smoother.apply(row);
      const key = lineKey(sequence, group);
      if (!Number.isNaN(key) && key === line.key && history.length) {
        history[0] = line.add(smoothed);
      } else {
        history.unshift(line.start(key, smoothed));
        if (history.length > o.visible) history.pop();
      }
      levels.update(history[0]);
    },
    // No fine rows here: the fallback stretches the wideband bins only.
    pushFine() {},
    setLens(next) { lens = next; },
    setFine() {},
    resize(width, height) {
      canvas.width = width;
      canvas.height = height;
    },
    draw() {
      if (!ctx || !history.length) return;
      const width = lens ? Math.max(1, Math.min(canvas.width, 2048)) : o.bins;
      // Bin shown in each output column (-1: outside the window).
      const column = Int32Array.from({ length: width }, (_, x) => {
        if (!lens) return x;
        const sx = (x + 0.5) / width;
        const u = Math.abs(sx - 0.5) * 2;
        const d = u <= lens.core ? lens.coreSpan * u / lens.core : lens.coreSpan + lens.b * Math.expm1(lens.k * (u - lens.core));
        const f = lens.focus + Math.sign(sx - 0.5) * d;
        return f < 0 || f > 1 ? -1 : Math.min(o.bins - 1, Math.floor(f * o.bins));
      });
      const image = ctx.createImageData(width, o.visible);
      const span = Math.max(0.02, levels.ceil - levels.floor);
      history.forEach((row, y) => {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (column[x] < 0) {
            image.data.set([15, 26, 43, 255], i);
            continue;
          }
          const t = Math.min(1, Math.max(0, (row[column[x]] / 255 - levels.floor) / span));
          const c = Math.round(t * 255) * 4;
          image.data[i] = COLORMAP[c];
          image.data[i + 1] = COLORMAP[c + 1];
          image.data[i + 2] = COLORMAP[c + 2];
          image.data[i + 3] = 255;
        }
      });
      const scratch = new OffscreenCanvas(width, o.visible);
      scratch.getContext("2d")?.putImageData(image, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(scratch, 0, 0, canvas.width, canvas.height);
    },
    dispose() {},
  };
}
