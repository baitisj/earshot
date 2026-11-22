import { describe, expect, it } from "vitest";
import { listenMessageSchema, parseJson } from "@/api/engine";
import { opusPlayable, splitPackets } from "./opus";

describe("splitPackets", () => {
  it("splits length-prefixed packets", () => {
    const packets = splitPackets(new Uint8Array([2, 0, 9, 8, 1, 0, 7]));
    expect(packets?.map((p) => [...p])).toEqual([[9, 8], [7]]);
  });

  it("reads the length as little-endian", () => {
    const bytes = new Uint8Array(2 + 300);
    bytes[0] = 300 & 0xff;
    bytes[1] = 300 >> 8;
    expect(splitPackets(bytes)?.[0].length).toBe(300);
  });

  it("refuses a truncated or empty packet", () => {
    expect(splitPackets(new Uint8Array([5, 0, 1]))).toBeNull();
    expect(splitPackets(new Uint8Array([1]))).toBeNull();
    expect(splitPackets(new Uint8Array([0, 0]))).toBeNull();
  });
});

describe("opus stream messages", () => {
  it("parses the engine's descriptor", () => {
    const message = parseJson(listenMessageSchema, JSON.stringify({ type: "opus", channels: 1, frame_ms: 20, rate_hz: 8000,
      channel_id: "A-1", generation: 3, source_generation: 2, raw: false }));
    expect(message?.type).toBe("opus");
  });

  it("reports no support where WebCodecs is missing", async () => {
    if (typeof AudioDecoder === "undefined") expect(await opusPlayable()).toBe(false);
  });
});
