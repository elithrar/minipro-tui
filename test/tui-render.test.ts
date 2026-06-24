import { expect, test } from "bun:test";

import { formatStatusLine, formatStatusSummary } from "../src/tui/render";

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

test("status summary shows matching chip and image as ready", () => {
  const summary = formatStatusSummary({
    programmerStatus: { connected: true, model: "T48", kind: "t48", raw: "T48" },
    database: "t48",
    selectedChip: "AT28C64B",
    selectedFile: { name: "image.bin", path: "image.bin", size: 8192, modifiedAt: new Date(0), sha256Short: "a1b2c3d4" },
    chipInfo: { name: "AT28C64B", memoryBytes: 8192, packageName: "DIP28", raw: "Name: AT28C64B" },
    job: { kind: "idle" },
    advanced: {},
    fileCount: 1,
    chipResultCount: 3,
    showAllFiles: false,
  });

  expect(summary).toContain("Fit     OK: image matches chip memory (8.0 KiB)");
  expect(summary).toContain("Next    w write preview");
  expect(summary).toContain("Chip    AT28C64B | 8.0 KiB | DIP28");
  expect(summary).toContain("Image   image.bin | 8.0 KiB | sha a1b2c3d4");
});

test("status summary blocks size mismatch by default", () => {
  const summary = formatStatusSummary({
    programmerStatus: { connected: false, raw: "[No programmer found]" },
    database: "t48",
    selectedChip: "AT28C64B",
    selectedFile: { name: "small.bin", path: "small.bin", size: 4096, modifiedAt: new Date(0), sha256Short: "a1b2c3d4" },
    chipInfo: { name: "AT28C64B", memoryBytes: 8192, packageName: "DIP28", raw: "Name: AT28C64B" },
    job: { kind: "idle" },
    advanced: {},
    fileCount: 1,
    chipResultCount: 1,
    showAllFiles: false,
  });

  expect(summary).toContain("Fit     Blocked: image 4.0 KiB vs chip 8.0 KiB");
  expect(summary).toContain("Next    Use a matching image or explicitly allow size mismatch");
});

test("status summary exposes dangerous overrides", () => {
  const summary = formatStatusSummary({
    programmerStatus: { connected: true, model: "T48", kind: "t48", raw: "T48" },
    database: "t48",
    selectedChip: "AT28C64B",
    selectedFile: { name: "small.bin", path: "small.bin", size: 4096, modifiedAt: new Date(0), sha256Short: "a1b2c3d4" },
    chipInfo: { name: "AT28C64B", memoryBytes: 8192, packageName: "DIP28", raw: "Name: AT28C64B" },
    job: { kind: "idle" },
    advanced: { allowSizeMismatch: true, disableReadbackCompare: true },
    fileCount: 1,
    chipResultCount: 1,
    showAllFiles: false,
  });

  expect(summary).toContain("Fit     Override: image 4.0 KiB vs chip 8.0 KiB");
  expect(summary).toContain("Safety  Review: size mismatch allowed, readback compare off");
});

test("status summary wraps to the available panel width", () => {
  const summary = formatStatusSummary(
    {
      programmerStatus: { connected: false, raw: "[No programmer found]" },
      database: "t48",
      selectedChip: "AT28C64B",
      selectedFile: { name: "911 chip 89 911 28pin 3.bin", path: "image.bin", size: 8192, modifiedAt: new Date(0), sha256Short: "8cfd26f7ef2b" },
      chipInfo: { name: "AT28C64B", packageName: "DIP28", raw: "Name: AT28C64B" },
      job: { kind: "idle" },
      advanced: {},
      fileCount: 1,
      chipResultCount: 3,
      showAllFiles: false,
    },
    { width: 44 },
  );

  expect(summary).toContain("Safety  Safe default: erase, blank, write,");
  expect(summary).toContain("        verify, compare");
  expect(summary).toContain("Image   911 chip 89 911 28pin 3.bin |");

  for (const line of summary.split("\n")) {
    expect(line.length).toBeLessThanOrEqual(44);
  }
});
