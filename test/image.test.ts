import { expect, test } from "bun:test";

import { normalizeImageBytes } from "../src/files/image";

test("normalizes Intel HEX data and fills address gaps", () => {
  const content = [
    ":020000000102FB",
    ":0100030003F9",
    ":00000001FF",
  ].join("\n");
  expect(normalizeImageBytes("image.hex", new TextEncoder().encode(content))).toEqual(new Uint8Array([1, 2, 0xff, 3]));
});

test("preserves nonzero structured-image addresses", () => {
  const content = [":020010000102EB", ":00000001FF"].join("\n");
  const normalized = normalizeImageBytes("offset.hex", new TextEncoder().encode(content));
  expect(normalized).toHaveLength(0x12);
  expect(normalized.slice(0, 0x10)).toEqual(new Uint8Array(0x10).fill(0xff));
  expect(normalized.slice(0x10)).toEqual(new Uint8Array([1, 2]));
});

test("normalizes S-record data", () => {
  const content = [
    "S1060000010203F3",
    "S9030000FC",
  ].join("\n");
  expect(normalizeImageBytes("image.srec", new TextEncoder().encode(content))).toEqual(new Uint8Array([1, 2, 3]));
});

test("rejects malformed structured images instead of treating text as bytes", () => {
  expect(() => normalizeImageBytes("image.hex", new TextEncoder().encode(":0100000001FF"))).toThrow();
  expect(() => normalizeImageBytes("image.srec", new TextEncoder().encode("not an s-record"))).toThrow();
  expect(() => normalizeImageBytes("image.srec", new TextEncoder().encode("S1060000010203F3"))).toThrow();
  expect(() => normalizeImageBytes("image.srec", new TextEncoder().encode("S1060000010203F3\nS5030002FA\nS9030000FC"))).toThrow();
  expect(() => normalizeImageBytes("image.hex", new TextEncoder().encode(":00000001FF\n:0100000001FE"))).toThrow();
});
