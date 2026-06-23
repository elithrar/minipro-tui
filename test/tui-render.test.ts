import { expect, test } from "bun:test";

import { formatStatusLine } from "../src/tui/render";

test("status line shows disconnected programmer state", () => {
  expect(
    formatStatusLine({
      programmerStatus: { connected: false, raw: "[No programmer found]" },
      database: "t48",
      job: { kind: "idle" },
    }),
  ).toContain("Programmer: disconnected");
});

test("status line shows selected file details", () => {
  expect(
    formatStatusLine({
      programmerStatus: { connected: true, model: "T48", kind: "t48", raw: "T48" },
      database: "t48",
      selectedChip: "AT28C64B",
      selectedFile: { name: "image.bin", path: "image.bin", size: 8192, modifiedAt: new Date(0), sha256Short: "a1b2c3d4" },
      job: { kind: "idle" },
    }),
  ).toContain("File: image.bin 8192 B a1b2c3d4");
});
