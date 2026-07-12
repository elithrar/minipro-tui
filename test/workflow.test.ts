import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { FileEntry, MiniproResult } from "../src/types";
import { captureDestination, runCompareWorkflow, runDefaultWriteWorkflow, runReadWorkflow, type WorkflowCommandRunner } from "../src/minipro/workflow";

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
  expect(writePath).toEndWith("image.bin.confirmed.bin");
  expect(writePath).not.toBe(path);
  expect(verifyPath).toBe(writePath);
  expect(calls).toEqual([
    ["-k"],
    ["-q", "T48", "-d", "AT28C64B"],
    ["-p", "AT28C64B", "-z"],
    ["-p", "AT28C64B", "-E"],
    ["-p", "AT28C64B", "-b"],
    ["-p", "AT28C64B", "-w", writePath, "--skip_erase", "--skip_verify"],
    ["-p", "AT28C64B", "-m", writePath],
    ["-p", "AT28C64B", "-r", result.readbackPath, "-c", "code"],
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
    runCommand: async (args) => ok(args, args[0] === "-k" ? "T48" : args.includes("-d") ? "Name: AT28C64B\nMemory: 8 Bytes" : ""),
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

test("write flow blocks when a successful pin command reports unsupported", async () => {
  const calls: string[][] = [];
  const result = await runDefaultWriteWorkflow({
    file: fileEntry("image.bin", 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 4, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: new Uint8Array([1, 2, 3, 4]),
    runCommand: async (args) => {
      calls.push(args);
      if (args[0] === "-k") return ok(args, "T48");
      if (args.includes("-z")) return ok(args, "Pin test is not supported");
      return ok(args);
    },
  });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("Pin/contact check is not supported");
  expect(calls).toHaveLength(3);
});

test("write flow rejects a different connected programmer before chip actions", async () => {
  const calls: string[][] = [];
  const result = await runDefaultWriteWorkflow({
    file: fileEntry("image.bin", 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 4, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: new Uint8Array([1, 2, 3, 4]),
    runCommand: async (args) => {
      calls.push(args);
      return ok(args, args[0] === "-k" ? "T56" : "");
    },
  });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("does not match confirmed database");
  expect(calls).toHaveLength(1);
});

test("write flow rejects an unrecognized connected programmer", async () => {
  const result = await runDefaultWriteWorkflow({
    file: fileEntry("image.bin", 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 4, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: new Uint8Array([1, 2, 3, 4]),
    runCommand: async (args) => ok(args, args[0] === "-k" ? "Found T76" : ""),
  });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("not recognized");
  expect(result.steps).toHaveLength(1);
});

test("write flow revalidates live chip size before destructive steps", async () => {
  const calls: string[][] = [];
  const result = await runDefaultWriteWorkflow({
    file: fileEntry("image.bin", 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 4, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: new Uint8Array([1, 2, 3, 4]),
    runCommand: async (args) => {
      calls.push(args);
      return ok(args, args[0] === "-k" ? "T48" : args.includes("-d") ? "Name: AT28C64B\nMemory: 8 Bytes" : "");
    },
  });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("changed after confirmation");
  expect(calls).toHaveLength(2);
});

test("default flow writes confirmed bytes even if the source path changes", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "changed.bin");
  await writeFile(path, new Uint8Array([1]));
  const calls: string[][] = [];
  const confirmedBytes = new Uint8Array([1, 2, 3, 4]);
  let writtenBytes: Uint8Array | undefined;
  const result = await runDefaultWriteWorkflow({
    file: fileEntry(path, 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 4, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes,
    runCommand: async (args) => {
      calls.push(args);
      if (args.includes("-w")) writtenBytes = await readFile(args[args.indexOf("-w") + 1]!);
      return ok(args, args[0] === "-k" ? "T48" : "");
    },
    readFileBytes: async () => confirmedBytes,
  });
  expect(result.ok).toBe(true);
  expect(calls.some((args) => args.includes("-w"))).toBe(true);
  expect(writtenBytes).toEqual(Buffer.from(confirmedBytes));
});

test("optional backup completes before erase and is preserved", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "backup-write.bin");
  const backupFile = join(dir, "original-backup.bin");
  await rm(backupFile, { force: true });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const original = new Uint8Array([9, 8, 7, 6]);
  await writeFile(path, bytes);
  const steps: string[] = [];

  const result = await runDefaultWriteWorkflow({
    file: fileEntry(path, 4),
    chip: "AT28C64B",
    chipInfo: { name: "AT28C64B", memoryBytes: 4, raw: "" },
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: bytes,
    backupFile,
    backupDestinationSnapshot: { exists: false },
    runCommand: async (args, step) => {
      steps.push(step);
      if (step === "backup existing chip") await writeFile(args[args.indexOf("-r") + 1]!, original);
      return ok(args, args[0] === "-k" ? "T48" : "");
    },
    readFileBytes: async () => bytes,
  });

  expect(result.ok).toBe(true);
  expect(steps.indexOf("backup existing chip")).toBeLessThan(steps.indexOf("erase"));
  expect(await readFile(backupFile)).toEqual(Buffer.from(original));
});

test("read workflow reads to a file and reports checksum", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const outputFile = join(dir, "read.bin");
  await rm(outputFile, { force: true });
  const calls: string[][] = [];
  const result = await runReadWorkflow({
    chip: "AT28C64B",
    outputFile,
    destinationSnapshot: { exists: false },
    confirmed: true,
    runCommand: async (args) => {
      calls.push(args);
      const readIndex = args.indexOf("-r");
      if (readIndex !== -1) await writeFile(args[readIndex + 1]!, new Uint8Array([1, 2, 3, 4]));
      return ok(args, args[0] === "-k" ? "T48" : "");
    },
  });
  expect(result.ok).toBe(true);
  expect(result.message).toContain("sha256");
  expect(calls[0]).toEqual(["-k"]);
  expect(calls[1]?.slice(0, 3)).toEqual(["-p", "AT28C64B", "-r"]);
  expect(calls[1]?.[3]).not.toBe(outputFile);
  expect(result.readbackPath).toBe(outputFile);
});

test("read workflow requires confirmation", async () => {
  const result = await runReadWorkflow({ chip: "AT28C64B", outputFile: "read.bin", destinationSnapshot: { exists: false }, confirmed: false, runCommand: async (args) => ok(args) });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("Confirm read");
});

test("reads refuse to replace an existing destination", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const outputFile = join(dir, "existing.bin");
  const original = new Uint8Array([9, 8, 7]);
  await writeFile(outputFile, original);

  const result = await runReadWorkflow({
    chip: "AT28C64B",
    outputFile,
    destinationSnapshot: await captureDestination(outputFile),
    confirmed: true,
    runCommand: async (args) => args[0] === "-k" ? ok(args, "T48") : { ...ok(args), exitCode: 1, stderr: "read failed" },
  });

  expect(result.ok).toBe(false);
  expect(result.message).toContain("never replaced");
  expect(await readFile(outputFile)).toEqual(Buffer.from(original));
});

test("read refuses to replace a destination created after confirmation", async () => {
  const dir = join(import.meta.dir, ".tmp-workflow");
  await mkdir(dir, { recursive: true });
  const outputFile = join(dir, "raced.bin");
  await Bun.file(outputFile).delete().catch(() => undefined);
  const result = await runReadWorkflow({
    chip: "AT28C64B",
    outputFile,
    destinationSnapshot: { exists: false },
    confirmed: true,
    runCommand: async (args) => {
      if (args[0] === "-k") return ok(args, "T48");
      await writeFile(args[args.indexOf("-r") + 1]!, new Uint8Array([1, 2, 3]));
      await writeFile(outputFile, new Uint8Array([9]));
      return ok(args);
    },
  });
  expect(result.ok).toBe(false);
  expect(await readFile(outputFile)).toEqual(Buffer.from([9]));
});

test("compare workflow reports matched hashes", async () => {
  const localBytes = new Uint8Array([1, 2, 3, 4]);
  const calls: string[][] = [];
  const result = await runCompareWorkflow({
    file: fileEntry("image.bin", 4),
    chip: "AT28C64B",
    confirmed: true,
    confirmedBytes: localBytes,
    runCommand: async (args) => {
      calls.push(args);
      return ok(args, args[0] === "-k" ? "T48" : "");
    },
    readFileBytes: async () => localBytes,
  });

  expect(result.ok).toBe(true);
  if (!result.readbackPath) throw new Error("Expected compare readback path.");
  expect(result.message).toContain("matched");
  expect(result.message).toContain("Local sha256");
  expect(result.message).toContain("Chip sha256");
  expect(result.originalSha256).toBe(result.readbackSha256);
  expect(calls).toEqual([
    ["-k"],
    ["-p", "AT28C64B", "-r", result.readbackPath, "-c", "code"],
  ]);
});

test("compare workflow reports mismatched hashes", async () => {
  const localBytes = new Uint8Array([1, 2, 3, 4]);
  const chipBytes = new Uint8Array([4, 3, 2, 1]);
  const result = await runCompareWorkflow({
    file: fileEntry("image.bin", 4),
    chip: "AT28C64B",
    confirmed: true,
    confirmedBytes: localBytes,
    runCommand: async (args) => ok(args, args[0] === "-k" ? "T48" : ""),
    readFileBytes: async () => chipBytes,
  });

  expect(result.ok).toBe(false);
  expect(result.message).toContain("files do not match");
  expect(result.message).toContain("Local sha256");
  expect(result.message).toContain("Chip sha256");
  expect(result.originalSha256).not.toBe(result.readbackSha256);
});

function ok(command: string[], stdout = ""): MiniproResult {
  if (!stdout && command.includes("-d")) stdout = "Name: AT28C64B\nMemory: 4 Bytes";
  return { command: ["minipro", ...command], exitCode: 0, stdout, stderr: "", durationMs: 1 };
}

function fileEntry(path: string, size: number): FileEntry {
  return { name: path.split("/").at(-1) ?? path, path, size, modifiedAt: new Date(), sha256Short: "abc123" };
}
