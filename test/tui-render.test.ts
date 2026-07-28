import { expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";

import { formatChipLabel, formatGuidanceLine, formatLogContent, formatStatusLine, formatStatusSummary, formatStatusSummaryContent, sanitizeLogLine } from "../src/tui/render";

test("status line shows disconnected programmer state", () => {
  expect(
    formatStatusLine({
      programmerStatus: { connected: false, raw: "[No programmer found]" },
      database: "t48",
      job: { kind: "idle" },
    }),
  ).toContain("USB disconnected | T48 catalog |");
});

test("status line stays compact", () => {
  const line = formatStatusLine({
    programmerStatus: { connected: true, model: "T48", kind: "t48", raw: "T48" },
    database: "t48",
    selectedChip: "AT28C64B",
    selectedFile: { name: "911 chip 89 911 28pin 3.bin", path: "image.bin", size: 8192, modifiedAt: new Date(0), sha256Short: "a1b2c3d4" },
    job: { kind: "idle" },
  });

  expect(line).toContain("USB T48 | T48 catalog | AT28C64B | 911 chip 89 911 28pin 3.bin | idle");
  expect(line).not.toContain("8192 B");
  expect(line).not.toContain("a1b2c3d4");
});

test("guidance prioritizes live work, action errors, blockers, and readiness", () => {
  const base = {
    programmerStatus: { connected: false, raw: "[No programmer found]" },
    database: "t48" as const,
    job: { kind: "idle" as const },
    advanced: {},
    activeCommandCancellable: false,
  };
  expect(formatGuidanceLine(base)).toContain("Next: choose an image");
  expect(formatGuidanceLine({ ...base, chipSearch: { query: "M27C64", phase: "results" } })).toContain('Searching t48 chips for "M27C64"');
  expect(formatGuidanceLine({ ...base, notice: { tone: "error", message: "Select an image before writing." } })).toContain("Action needed: Select an image before writing.");
  expect(formatGuidanceLine({ ...base, job: { kind: "failed", step: "read", message: "\u001b[31mread failed\ncheck connection" } })).toContain("Failed: read failed check connection");

  const selected = {
    ...base,
    selectedChip: "AT28C64B",
    selectedFile: { name: "small.bin", path: "small.bin", size: 4096, modifiedAt: new Date(0), sha256Short: "a1b2c3d4" },
    chipInfo: { name: "AT28C64B", memoryBytes: 8192, raw: "Name: AT28C64B" },
  };
  expect(formatGuidanceLine(selected)).toContain("Blocked: image and chip sizes differ");
  expect(formatGuidanceLine({ ...selected, selectedFile: { ...selected.selectedFile, size: 8192 } })).toContain("Ready to review. Connect a programmer");
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
  const offChunks = content.chunks.filter((chunk) => chunk.text === "OFF" && chunk.bg !== undefined);
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

test("status defers structured image sizing until normalization", () => {
  const summary = formatStatusSummary({
    programmerStatus: { connected: false, raw: "" },
    database: "t48",
    selectedChip: "AT28C64B",
    selectedFile: { name: "image.hex", path: "image.hex", size: 24000, modifiedAt: new Date(0), sha256Short: "abc" },
    chipInfo: { name: "AT28C64B", memoryBytes: 8192, raw: "" },
    job: { kind: "idle" },
    advanced: {},
    fileCount: 1,
    chipResultCount: 1,
    showAllFiles: false,
  });
  expect(summary).toContain("CHECK structured image normalized on confirm");
  expect(summary).not.toContain("BLOCKED");
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
      canErase: true,
      raw: "Name: M27C64A@DIP28",
    }),
  ).toEqual({ name: "M27C64A@DIP28 (28 pin DIP, erasable)", description: "", value: "M27C64A@DIP28" });
  expect(formatChipLabel("AT28C64B")).toEqual({ name: "AT28C64B (default)", description: "default", value: "AT28C64B" });
  expect(formatChipLabel("AT28C64B@DIP28")).toEqual({ name: "AT28C64B@DIP28 (default)", description: "default", value: "AT28C64B@DIP28" });
});

test("log formatting strips terminal escape sequences and bolds operation traces", () => {
  expect(sanitizeLogLine("\u001b[KReading Code... 12\r")).toBe("Reading Code... 12");

  const content = formatLogContent(["$ direct USB operation", "done in 25ms"]);
  expect(content.chunks[0]?.text).toBe("$ direct USB operation\n");
  expect(content.chunks[0]?.attributes).toBe(TextAttributes.BOLD);
  expect(content.chunks[0]?.bg?.toInts()).toEqual([55, 51, 40, 255]);
  expect(content.chunks[0]?.fg?.toInts()).toEqual([255, 176, 0, 255]);
  expect(content.chunks[1]?.attributes).toBeUndefined();
  expect(content.chunks[1]?.bg).toBeUndefined();
});
