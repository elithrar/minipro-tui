import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { FileEntry, MiniproResult } from "../src/types";
import { runCompareWorkflow, runDefaultWriteWorkflow, runReadWorkflow, type WorkflowCommandRunner } from "../src/minipro/workflow";

test("default flow includes pin check, erase, blank check, write, verify, and readback compare", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "image.bin");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await writeFile(path, bytes);
  const calls: string[][] = [];
  const runCommand: WorkflowCommandRunner = async (args) => {
    calls.push(args);
    return ok(args, args[0] === "-k" ? "T48" : "");
  };

  const result = await runDefaultWriteWorkflow({
    file: fileEntry(path, 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 4, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: bytes,
    runCommand,
    readFileBytes: async () => bytes,
  });

  expect(result.ok).toBe(true);
  if (!result.readbackPath) throw new Error("Expected readback path.");
  const writePath = calls[5]?.[3];
  const verifyPath = calls[6]?.[3];
  if (!writePath || !verifyPath) throw new Error("Expected temp write and verify paths.");
  expect(writePath).toEndWith("image.bin");
  expect(writePath).not.toBe(path);
  expect(verifyPath).toBe(writePath);
  expect(calls).toEqual([
    ["-k"],
    ["-q", "T48", "-d", "AT28C64B"],
    ["-p", "AT28C64B", "-z"],
    ["-p", "AT28C64B", "-E"],
    ["-p", "AT28C64B", "-b"],
    ["-p", "AT28C64B", "-w", writePath],
    ["-p", "AT28C64B", "-m", writePath],
    ["-p", "AT28C64B", "-r", result.readbackPath],
  ]);
});

test("default flow blocks on missing file", async () => {
  const result = await runDefaultWriteWorkflow({ chip: "AT28C64B", chipInfo: { name: "AT28C64B", raw: "" }, programmerKind: "t48", confirmed: true, runCommand: async (args) => ok(args) });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("Select a file");
});

test("default flow blocks on missing chip", async () => {
  const result = await runDefaultWriteWorkflow({ file: fileEntry("image.bin", 4), chipInfo: { name: "AT28C64B", raw: "" }, programmerKind: "t48", confirmed: true, runCommand: async (args) => ok(args) });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("Select a chip");
});

test("default flow blocks on known size mismatch", async () => {
  const result = await runDefaultWriteWorkflow({
    file: fileEntry("image.bin", 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 8, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: new Uint8Array([1, 2, 3, 4]),
    runCommand: async (args) => ok(args),
  });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("does not match");
});

test("default flow allows size mismatch only when explicit override is enabled", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "override.bin");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await writeFile(path, bytes);
  const result = await runDefaultWriteWorkflow({
    file: fileEntry(path, 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 8, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    advanced: { allowSizeMismatch: true },
    confirmedBytes: bytes,
    runCommand: async (args) => ok(args, args[0] === "-k" ? "T48" : ""),
    readFileBytes: async () => bytes,
  });
  expect(result.ok).toBe(true);
});

test("workflow stops after a failed step", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "fail.bin");
  await writeFile(path, new Uint8Array([1, 2, 3, 4]));
  const calls: string[][] = [];
  const result = await runDefaultWriteWorkflow({
    file: fileEntry(path, 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 4, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: new Uint8Array([1, 2, 3, 4]),
    runCommand: async (args) => {
      calls.push(args);
      if (args.includes("-z")) return { ...ok(args), exitCode: 1, stderr: "pin fail" };
      return ok(args, args[0] === "-k" ? "T48" : "");
    },
  });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("pin/contact check failed");
  expect(calls).toHaveLength(3);
});

test("default flow writes confirmed bytes even if the source path changes", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "changed.bin");
  await writeFile(path, new Uint8Array([1]));
  const calls: string[][] = [];
  const confirmedBytes = new Uint8Array([1, 2, 3, 4]);
  const result = await runDefaultWriteWorkflow({
    file: fileEntry(path, 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 4, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes,
    runCommand: async (args) => {
      calls.push(args);
      return ok(args, args[0] === "-k" ? "T48" : "");
    },
    readFileBytes: async () => confirmedBytes,
  });
  expect(result.ok).toBe(true);
  expect(calls.some((args) => args.includes("-w"))).toBe(true);
});

test("read workflow reads to a file and reports checksum", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const outputFile = join(dir, "read.bin");
  const calls: string[][] = [];
  const result = await runReadWorkflow({
    chip: "AT28C64B",
    outputFile,
    confirmed: true,
    runCommand: async (args) => {
      calls.push(args);
      if (args.includes("-r")) await writeFile(outputFile, new Uint8Array([1, 2, 3, 4]));
      return ok(args, args[0] === "-k" ? "T48" : "");
    },
  });
  expect(result.ok).toBe(true);
  expect(result.message).toContain("sha256");
  expect(calls).toEqual([
    ["-k"],
    ["-p", "AT28C64B", "-r", outputFile],
  ]);
});

test("read workflow requires confirmation", async () => {
  const result = await runReadWorkflow({ chip: "AT28C64B", outputFile: "read.bin", confirmed: false, runCommand: async (args) => ok(args) });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("Confirm read");
});

test("compare workflow reports matched hashes", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "compare-match.bin");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  await writeFile(path, bytes);
  const calls: string[][] = [];
  const result = await runCompareWorkflow({
    file: fileEntry(path, 4),
    chip: "AT28C64B",
    confirmed: true,
    runCommand: async (args) => {
      calls.push(args);
      if (args.includes("-r")) await writeFile(args.at(-1) ?? "", bytes);
      return ok(args, args[0] === "-k" ? "T48" : "");
    },
  });

  expect(result.ok).toBe(true);
  expect(result.message).toContain("matched");
  expect(result.originalSha256).toBe(result.readbackSha256);
  expect(calls).toEqual([
    ["-k"],
    ["-p", "AT28C64B", "-r", result.readbackPath],
  ]);
});

test("compare workflow reports files do not match with both hashes", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "compare-mismatch.bin");
  await writeFile(path, new Uint8Array([1, 2, 3, 4]));
  const result = await runCompareWorkflow({
    file: fileEntry(path, 4),
    chip: "AT28C64B",
    confirmed: true,
    runCommand: async (args) => {
      if (args.includes("-r")) await writeFile(args.at(-1) ?? "", new Uint8Array([4, 3, 2, 1]));
      return ok(args, args[0] === "-k" ? "T48" : "");
    },
  });

  expect(result.ok).toBe(false);
  expect(result.message).toContain("files do not match");
  expect(result.message).toContain("Local sha256");
  expect(result.message).toContain("chip sha256");
  expect(result.originalSha256).toBeDefined();
  expect(result.readbackSha256).toBeDefined();
  expect(result.originalSha256).not.toBe(result.readbackSha256);
});

function ok(command: string[], stdout = ""): MiniproResult {
  return { command: ["minipro", ...command], exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

function fileEntry(path: string, size: number): FileEntry {
  return { name: path.split("/").at(-1) ?? path, path, size, modifiedAt: new Date(), sha256Short: "abc123" };
}
