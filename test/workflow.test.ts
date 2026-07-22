import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { FileEntry } from "../src/types";
import { captureDestination, runCompareWorkflow, runDefaultWriteWorkflow, runReadWorkflow } from "../src/xgecu/workflow";
import { FakeBackend, TEST_CHIP } from "./support/fake-backend";

const tempDirectory = join(import.meta.dir, ".tmp-workflow");

test("write flow preserves the direct backend safety sequence", async () => {
  const backend = new FakeBackend();
  backend.contents = new Uint8Array([9, 8, 7, 6]);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const steps: string[] = [];

  const result = await runDefaultWriteWorkflow({
    backend,
    file: fileEntry("image.bin", 4),
    chip: TEST_CHIP.name,
    chipInfo: TEST_CHIP,
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: bytes,
    onStep: (step) => steps.push(step),
  });

  expect(result.ok).toBe(true);
  expect(backend.calls).toEqual(["pins", "write", "read"]);
  expect(steps).toEqual(["pin/contact check", "erase, blank check, write, and verify", "independent readback compare"]);
  expect(backend.contents).toEqual(bytes);
});

test("write flow passes safety options to xgecu and freezes input bytes", async () => {
  const backend = new FakeBackend();
  const confirmed = new Uint8Array([1, 2, 3, 4]);
  let written: Uint8Array | undefined;
  backend.onWrite = async (options) => {
    written = options.data.slice();
    expect(options.erase).toBe(false);
    expect(options.verify).toBe(false);
    expect(options.unprotectBefore).toBe(false);
    expect(options.continueOnIdMismatch).toBe(true);
    confirmed.fill(9);
    backend.contents = options.data.slice();
  };

  const result = await runDefaultWriteWorkflow({
    backend,
    file: fileEntry("image.bin", 4),
    chip: TEST_CHIP.name,
    chipInfo: TEST_CHIP,
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: confirmed,
    advanced: { skipErase: true, skipVerify: true, ignoreIdMismatch: true },
  });

  expect(result.ok).toBe(true);
  expect(written).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test("write protection changes require explicit device support", async () => {
  const backend = new FakeBackend();
  const result = await runDefaultWriteWorkflow({
    backend,
    file: fileEntry("image.bin", 4),
    chip: TEST_CHIP.name,
    chipInfo: TEST_CHIP,
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: new Uint8Array(4),
    advanced: { unprotectBefore: true },
  });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("does not support disabling write protection");
  expect(backend.calls).toEqual([]);
});

test("write flow stops on a failed pin check", async () => {
  const backend = new FakeBackend();
  backend.checkPinContacts = async () => {
    backend.calls.push("pins");
    return { passed: false, checkedPins: [1, 2], badPins: [2] };
  };
  const result = await runDefaultWriteWorkflow({
    backend,
    file: fileEntry("image.bin", 4),
    chip: TEST_CHIP.name,
    chipInfo: TEST_CHIP,
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: new Uint8Array(4),
  });
  expect(result.ok).toBe(false);
  expect(result.message).toContain("pin 2");
  expect(backend.calls).toEqual(["pins"]);
});

test("pre-write backup is committed before mutation", async () => {
  await mkdir(tempDirectory, { recursive: true });
  const backup = join(tempDirectory, "backup.bin");
  await rm(backup, { force: true });
  const backend = new FakeBackend();
  backend.contents = new Uint8Array([9, 8, 7, 6]);
  const result = await runDefaultWriteWorkflow({
    backend,
    file: fileEntry("image.bin", 4),
    chip: TEST_CHIP.name,
    chipInfo: TEST_CHIP,
    programmerKind: "t48",
    confirmed: true,
    confirmedBytes: new Uint8Array([1, 2, 3, 4]),
    backupFile: backup,
    backupDestinationSnapshot: { exists: false },
  });
  expect(result.ok).toBe(true);
  expect(backend.calls).toEqual(["pins", "read", "write", "read"]);
  expect(await readFile(backup)).toEqual(Buffer.from([9, 8, 7, 6]));
});

test("read refuses existing and raced destinations", async () => {
  await mkdir(tempDirectory, { recursive: true });
  const existing = join(tempDirectory, "existing.bin");
  await writeFile(existing, new Uint8Array([9]));
  const backend = new FakeBackend();
  const existingResult = await runReadWorkflow({
    backend, chip: TEST_CHIP.name, programmerKind: "t48", confirmed: true,
    outputFile: existing, destinationSnapshot: await captureDestination(existing),
  });
  expect(existingResult.ok).toBe(false);
  expect(await readFile(existing)).toEqual(Buffer.from([9]));

  const raced = join(tempDirectory, "raced.bin");
  await rm(raced, { force: true });
  backend.onRead = async () => {
    await writeFile(raced, new Uint8Array([7]));
    return new Uint8Array([1, 2, 3, 4]);
  };
  const racedResult = await runReadWorkflow({
    backend, chip: TEST_CHIP.name, programmerKind: "t48", confirmed: true,
    outputFile: raced, destinationSnapshot: { exists: false },
  });
  expect(racedResult.ok).toBe(false);
  expect(await readFile(raced)).toEqual(Buffer.from([7]));
});

test("compare reports matching and mismatching readbacks", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const backend = new FakeBackend();
  backend.contents = bytes.slice();
  const input = {
    backend, file: fileEntry("image.bin", 4), chip: TEST_CHIP.name,
    programmerKind: "t48" as const, confirmed: true, confirmedBytes: bytes,
  };
  expect((await runCompareWorkflow(input)).ok).toBe(true);
  backend.contents[3] = 5;
  const mismatch = await runCompareWorkflow(input);
  expect(mismatch.ok).toBe(false);
  expect(mismatch.message).toContain("Compare failed");
});

function fileEntry(path: string, size: number): FileEntry {
  return { name: path, path, size, modifiedAt: new Date(0), sha256Short: "test" };
}
