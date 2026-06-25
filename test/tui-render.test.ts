import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";

import { formatChipLabel, formatLogContent, formatStatusLine, formatStatusSummary, sanitizeLogLine } from "../src/tui/render";

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

test("chip labels include useful database metadata", () => {
  expect(
    formatChipLabel("M27C64A@DIP28", {
      name: "M27C64A@DIP28",
      memoryBytes: 8192,
      packageName: "DIP28",
      vcc: "5V",
      vpp: "12V",
      pulseDelay: "1000us",
      raw: "Name: M27C64A@DIP28",
    }),
  ).toEqual({ name: "M27C64A@DIP28 (5V, 28 pin DIP, 1000us)", description: "", value: "M27C64A@DIP28" });
  expect(formatChipLabel("AT28C64B")).toEqual({ name: "AT28C64B (default)", description: "default", value: "AT28C64B" });
});

test("log formatting strips terminal escape sequences and bolds commands", () => {
  expect(sanitizeLogLine("\u001b[KReading Code... 12\r")).toBe("Reading Code... 12");

  const content = formatLogContent(['$ ["minipro","-Q"]', "exit 0 in 25ms"]);
  expect(content.chunks[0]?.text).toBe('$ ["minipro","-Q"]\n');
  expect(content.chunks[0]?.attributes).toBe(TextAttributes.BOLD);
  expect(content.chunks[1]?.attributes).toBeUndefined();
});
