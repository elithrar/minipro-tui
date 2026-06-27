import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";

import { formatChipLabel, formatLogContent, formatStatusLine, formatStatusSummary, formatStatusSummaryContent, sanitizeLogLine } from "../src/tui/render";

test("status line shows disconnected programmer state", () => {
  expect(
    formatStatusLine({
      programmerStatus: { connected: false, raw: "[No programmer found]" },
      database: "t48",
      job: { kind: "idle" },
    }),
  ).toContain("| disconnected | t48 |");
});

test("status line stays compact", () => {
  const line = formatStatusLine({
    programmerStatus: { connected: true, model: "T48", kind: "t48", raw: "T48" },
    database: "t48",
    selectedChip: "AT28C64B",
    selectedFile: { name: "911 chip 89 911 28pin 3.bin", path: "image.bin", size: 8192, modifiedAt: new Date(0), sha256Short: "a1b2c3d4" },
    job: { kind: "idle" },
  });

  expect(line).toContain("| T48 | t48 | AT28C64B | 911 chip 89 911 28pin 3.bin | idle");
  expect(line).not.toContain("8192 B");
  expect(line).not.toContain("a1b2c3d4");
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

  expect(summary).toContain("Fit      OK 8.0 KiB");
  expect(summary).toContain("Erase    ON");
  expect(summary).toContain("Blank    ON");
  expect(summary).toContain("Write    ON");
  expect(summary).toContain("Verify   ON");
  expect(summary).toContain("Compare  ON");
  expect(summary).toContain("Chip     AT28C64B / 8.0 KiB / DIP28");
  expect(summary).toContain("Image    image.bin / 8.0 KiB / a1b2c3d4");
  expect(summary).not.toContain("Next");
});

test("status summary styles enabled and dangerous disabled stages", () => {
  const content = formatStatusSummaryContent({
    programmerStatus: { connected: true, model: "T48", kind: "t48", raw: "T48" },
    database: "t48",
    selectedChip: "AT28C64B",
    selectedFile: { name: "image.bin", path: "image.bin", size: 8192, modifiedAt: new Date(0), sha256Short: "a1b2c3d4" },
    chipInfo: { name: "AT28C64B", memoryBytes: 8192, packageName: "DIP28", raw: "Name: AT28C64B" },
    job: { kind: "idle" },
    advanced: { skipVerify: true, disableReadbackCompare: true },
    fileCount: 1,
    chipResultCount: 3,
    showAllFiles: false,
  });

  const onChunk = content.chunks.find((chunk) => chunk.text === "ON");
  const offChunks = content.chunks.filter((chunk) => chunk.text === "OFF");
  expect(onChunk?.attributes).toBe(TextAttributes.BOLD);
  expect(offChunks).toHaveLength(2);
  expect(offChunks.every((chunk) => chunk.attributes === TextAttributes.BOLD && chunk.bg !== undefined)).toBe(true);
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

  expect(summary).toContain("Fit      BLOCKED 4.0 KiB vs 8.0 KiB");
  expect(summary).not.toContain("Next");
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

  expect(summary).toContain("Fit      OVERRIDE 4.0 KiB vs 8.0 KiB");
  expect(summary).toContain("Compare  OFF");
  expect(summary).toContain("Safety   REVIEW 2 overrides");
});

test("status summary stays within the available panel width", () => {
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

  expect(summary).toContain("Safety   OK defaults");
  expect(summary).toContain("Image    911 chip 89 911 28pin 3.bin / 8....");

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
  expect(content.chunks[0]?.bg?.toInts()).toEqual([40, 40, 40, 255]);
  expect(content.chunks[0]?.fg?.toInts()).toEqual([250, 178, 131, 255]);
  expect(content.chunks[1]?.attributes).toBeUndefined();
  expect(content.chunks[1]?.bg).toBeUndefined();
});
