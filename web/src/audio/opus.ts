/**
 * Live Opus from the engine, decoded by the browser (WebCodecs). The decoder runs at 48 kHz
 * whatever the stream's rate, so the worklet plays its output without upsampling 8 kHz audio.
 */
const CONFIG = { codec: "opus", sampleRate: 48000, numberOfChannels: 1 } as const;
const PACKET_US = 20_000;
/** Packets waiting in the decoder before the stream is restarted at the live edge. */
const MAX_QUEUE = 25;

export async function opusPlayable(): Promise<boolean> {
  if (typeof AudioDecoder === "undefined" || typeof EncodedAudioChunk === "undefined") return false;
  try {
    return (await AudioDecoder.isConfigSupported(CONFIG)).supported === true;
  } catch {
    return false;
  }
}

/** One binary message: packets, each after its length as a little-endian u16. */
export function splitPackets(bytes: Uint8Array): Uint8Array[] | null {
  const packets: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 2 > bytes.length) return null;
    const length = bytes[at] | (bytes[at + 1] << 8);
    at += 2;
    if (length === 0 || at + length > bytes.length) return null;
    packets.push(bytes.subarray(at, at + length));
    at += length;
  }
  return packets;
}

export class OpusStream {
  private decoder: AudioDecoder | null = null;
  private timestamp = 0;
  private readonly sink: (data: Float32Array<ArrayBuffer>, rate: number) => void;
  private readonly onError: () => void;

  constructor(sink: (data: Float32Array<ArrayBuffer>, rate: number) => void, onError: () => void) {
    this.sink = sink;
    this.onError = onError;
  }

  private open() {
    const decoder: AudioDecoder = new AudioDecoder({
      output: (audio) => {
        try {
          if (decoder !== this.decoder) return;
          const data = new Float32Array(audio.numberOfFrames);
          audio.copyTo(data, { planeIndex: 0, format: "f32-planar" });
          this.sink(data, audio.sampleRate);
        } finally {
          audio.close();
        }
      },
      error: () => {
        if (decoder === this.decoder) this.onError();
      },
    });
    decoder.configure(CONFIG);
    this.decoder = decoder;
    return decoder;
  }

  decode(packets: Uint8Array[]) {
    try {
      if ((this.decoder?.decodeQueueSize ?? 0) > MAX_QUEUE) this.reset();
      const decoder = this.decoder ?? this.open();
      for (const data of packets) {
        decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: this.timestamp, duration: PACKET_US, data }));
        this.timestamp += PACKET_US;
      }
    } catch {
      this.onError();
    }
  }

  /** Forget everything queued; the next packet starts a fresh decoder. */
  reset() {
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder && decoder.state !== "closed") decoder.close();
  }
}
