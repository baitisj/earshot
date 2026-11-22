import { describe, expect, it } from "vitest";
import { decodeFsp1, FSP1_HEADER } from "./spectrum";

function fsp1(rows: number[][], bins = 4, magic = "FSP1") {
  const buffer = new ArrayBuffer(FSP1_HEADER + rows.length * (8 + bins));
  const view = new DataView(buffer);
  [...magic].forEach((c, i) => view.setUint8(i, c.charCodeAt(0)));
  view.setUint16(4, bins, true);
  view.setUint16(6, rows.length, true);
  view.setFloat64(8, 454.0e6, true);
  view.setFloat64(16, 100e3, true);
  view.setFloat32(24, -160, true);
  view.setFloat32(28, 0, true);
  view.setBigUint64(32, 42n, true);
  rows.forEach((row, r) => {
    const offset = FSP1_HEADER + r * (8 + bins);
    view.setBigUint64(offset, BigInt(40 + r), true);
    new Uint8Array(buffer, offset + 8, bins).set(row);
  });
  return buffer;
}

describe("FSP1", () => {
  it("decodes rows by waterfall sequence", () => {
    const batch = decodeFsp1(fsp1([[1, 2, 3, 4], [5, 6, 7, 8]]))!;
    expect(batch).toMatchObject({ centerHz: 454e6, rateHz: 100e3, lowDb: -160, highDb: 0, sequence: 42, bins: 4 });
    expect(batch.rows.map((r) => r.sequence)).toEqual([40, 41]);
    expect([...batch.rows[1].bins]).toEqual([5, 6, 7, 8]);
  });
  it("rejects other magic and truncated bodies", () => {
    expect(decodeFsp1(fsp1([[1, 2, 3, 4]], 4, "RSP1"))).toBeNull();
    expect(decodeFsp1(fsp1([[1, 2, 3, 4]]).slice(0, FSP1_HEADER + 5))).toBeNull();
  });
});
