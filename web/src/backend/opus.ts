import type { AudioDescriptor } from "@/api/engine";

/** The engine's 20 ms Opus packets (`/api/listen?codec=opus`) decoded back to Int16 PCM with
 * WebCodecs. Voice and SSB arrive this way at about 16 kbit/s instead of 128; raw FM stays PCM. */

const RATES = [8000, 12000, 16000, 24000, 48000];

let support: boolean | null = null;

/** Starts the one-time WebCodecs check; until it answers (or where it says no) listen uses PCM. */
export function opusSupported(): boolean {
  if (support !== null) return support;
  if (typeof AudioDecoder === "undefined" || typeof EncodedAudioChunk === "undefined") return (support = false);
  support = false;
  AudioDecoder.isConfigSupported({ codec: "opus", sampleRate: 8000, numberOfChannels: 1 })
    .then((r) => (support = r.supported === true))
    .catch(() => (support = false));
  return false;
}

/** For tests. */
export function resetOpusSupport(value: boolean | null = null) {
  support = value;
}

export class OpusStream {
  private decoder: AudioDecoder | null = null;
  private rate = 0;
  private timestamp = 0;
  private queue: AudioDescriptor[] = [];
  private readonly onPcm: (descriptor: AudioDescriptor, pcm: Int16Array) => void;
  private readonly onError: () => void;

  constructor(onPcm: (descriptor: AudioDescriptor, pcm: Int16Array) => void, onError: () => void) {
    this.onPcm = onPcm;
    this.onError = onError;
  }

  decode(descriptor: AudioDescriptor, packet: ArrayBuffer) {
    if (!RATES.includes(descriptor.rate_hz)) return;
    if (!this.decoder || this.rate !== descriptor.rate_hz) this.open(descriptor.rate_hz);
    const decoder = this.decoder;
    if (!decoder) return;
    this.queue.push(descriptor);
    const duration = Math.round((descriptor.samples / descriptor.rate_hz) * 1e6);
    try {
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: this.timestamp, duration, data: packet }));
    } catch {
      this.queue.pop();
      this.fail();
      return;
    }
    this.timestamp += duration;
  }

  close() {
    this.queue = [];
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = null;
  }

  private open(rate: number) {
    this.close();
    this.rate = rate;
    this.timestamp = 0;
    const decoder = new AudioDecoder({
      output: (data) => this.output(data),
      error: () => this.fail(),
    });
    try {
      decoder.configure({ codec: "opus", sampleRate: rate, numberOfChannels: 1 });
    } catch {
      decoder.close();
      this.fail();
      return;
    }
    this.decoder = decoder;
  }

  private output(data: AudioData) {
    const descriptor = this.queue.shift();
    try {
      if (!descriptor) return;
      const n = data.numberOfFrames;
      const f32 = new Float32Array(n);
      data.copyTo(f32, { planeIndex: 0, format: "f32-planar" });
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32768)));
      this.onPcm({ ...descriptor, encoding: "s16le", samples: n }, pcm);
    } finally {
      data.close();
    }
  }

  private fail() {
    this.close();
    this.onError();
  }
}
