import { open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { sha256Bytes } from "../files/hash";
import type { AdvancedOptions, ChipInfo, FileEntry, ProgrammerKind } from "../types";
import type { BackendProgress, ProgrammerBackend, ReadOptions } from "./backend";

export type WorkflowStepResult = { step: string };

export type WorkflowResult = {
  ok: boolean;
  message: string;
  steps: WorkflowStepResult[];
  originalSha256?: string;
  readbackSha256?: string;
  readbackPath?: string;
};

export type DestinationSnapshot =
  | { exists: false }
  | { exists: true; device: number; inode: number; size: number; mtimeMs: number };

type CommonInput = {
  backend: ProgrammerBackend;
  chip?: string;
  programmerKind: ProgrammerKind;
  confirmed: boolean;
  advanced?: AdvancedOptions;
  signal?: AbortSignal;
  onStep?: (step: string, cancellable: boolean) => void;
  onLog?: (line: string) => void;
};

export type DefaultWriteWorkflowInput = CommonInput & {
  file?: FileEntry;
  chipInfo?: ChipInfo;
  confirmedBytes?: Uint8Array;
  confirmedSha256?: string;
  backupFile?: string;
  backupDestinationSnapshot?: DestinationSnapshot;
};

export type ReadWorkflowInput = CommonInput & {
  outputFile?: string;
  destinationSnapshot: DestinationSnapshot;
};

export type CompareWorkflowInput = CommonInput & {
  file?: FileEntry;
  confirmedBytes?: Uint8Array;
  confirmedSha256?: string;
};

export async function runDefaultWriteWorkflow(input: DefaultWriteWorkflowInput): Promise<WorkflowResult> {
  const steps: WorkflowStepResult[] = [];
  const advanced = input.advanced ?? {};
  if (!input.file) return failPrecondition("Select a file before starting the write flow.");
  if (!input.chip || !input.chipInfo) return failPrecondition("Select a chip and load its details before starting the write flow.");
  if (!input.confirmed) return failPrecondition("Confirm the write flow before starting.");
  if (!input.confirmedBytes) return failPrecondition("Freeze selected file bytes before confirming the write flow.");

  const bytes = input.confirmedBytes.slice();
  const originalSha256 = input.confirmedSha256 ?? sha256Bytes(bytes);
  if (input.chipInfo.memoryBytes === undefined) {
    return { ok: false, message: "Chip memory size is unavailable.", steps, originalSha256 };
  }
  if (bytes.byteLength !== input.chipInfo.memoryBytes && !advanced.allowSizeMismatch) {
    return { ok: false, message: `Confirmed image size ${bytes.byteLength} B does not match chip memory size ${input.chipInfo.memoryBytes} B.`, steps, originalSha256 };
  }
  if (bytes.byteLength !== input.chipInfo.memoryBytes && !advanced.skipErase) {
    return { ok: false, message: "Size mismatch writes require skip erase because xgecu only erases full code-memory images.", steps, originalSha256 };
  }
  if (input.backupFile && !input.backupDestinationSnapshot) {
    return { ok: false, message: "Capture the backup destination before confirmation.", steps, originalSha256 };
  }
  if (input.backupDestinationSnapshot?.exists) {
    return { ok: false, message: "Choose a new backup filename; existing files are never replaced.", steps, originalSha256 };
  }
  if (advanced.unprotectBefore && !input.chipInfo.supportsUnprotect) {
    return { ok: false, message: "The selected chip does not support disabling write protection through xgecu.", steps, originalSha256 };
  }

  input.onLog?.(`Selected ${input.file.name}: ${bytes.byteLength} B sha256 ${originalSha256}`);
  try {
    if (input.chipInfo.supportsPinCheck && input.programmerKind === "t48") {
      step(input, steps, "pin/contact check", true);
      const pins = await input.backend.checkPinContacts(readOptions(input));
      if (!pins.passed) {
        return { ok: false, message: `Pin/contact check failed on pin${pins.badPins.length === 1 ? "" : "s"} ${pins.badPins.join(", ")}.`, steps, originalSha256 };
      }
    } else {
      input.onLog?.("Pin/contact check is unavailable for this chip and programmer; continuing.");
    }

    if (input.backupFile) {
      step(input, steps, "backup existing chip", true);
      const backup = await input.backend.readROM(readOptions(input));
      await writeNewFile(input.backupFile, backup, input.backupDestinationSnapshot!);
      input.onLog?.(`Backed up ${backup.byteLength} B to ${resolve(input.backupFile)}. sha256 ${sha256Bytes(backup)}`);
    }

    step(input, steps, "erase, blank check, write, and verify", false);
    await input.backend.writeROM({
      ...readOptions(input),
      data: bytes,
      erase: Boolean(input.chipInfo.canErase) && !advanced.skipErase,
      verify: !advanced.skipVerify,
      unprotectBefore: Boolean(advanced.unprotectBefore),
      onProgress: progressLogger(input.onLog),
    });

    if (advanced.disableReadbackCompare) {
      return { ok: true, message: `Write completed. Original sha256 ${originalSha256}. Readback compare disabled.`, steps, originalSha256 };
    }

    step(input, steps, "independent readback compare", true);
    const readback = await input.backend.readROM({ ...readOptions(input), onProgress: progressLogger(input.onLog) });
    const readbackSha256 = sha256Bytes(readback);
    if (!bytesEqual(bytes, readback)) {
      return { ok: false, message: `Readback compare failed. Original sha256 ${originalSha256}, readback sha256 ${readbackSha256}.`, steps, originalSha256, readbackSha256 };
    }
    return { ok: true, message: `Write, verify, and readback compare completed. sha256 ${originalSha256}.`, steps, originalSha256, readbackSha256 };
  } catch (error) {
    return { ok: false, message: formatError(error), steps, originalSha256 };
  }
}

export async function runReadWorkflow(input: ReadWorkflowInput): Promise<WorkflowResult> {
  const steps: WorkflowStepResult[] = [];
  if (!input.chip) return failPrecondition("Select a chip before starting read mode.");
  if (!input.outputFile) return failPrecondition("Choose an output file before starting read mode.");
  if (!input.confirmed) return failPrecondition("Confirm read before starting.");
  if (input.destinationSnapshot.exists) return failPrecondition("Choose a new output filename; existing files are never replaced.");
  try {
    step(input, steps, "read chip", true);
    const bytes = await input.backend.readROM({ ...readOptions(input), onProgress: progressLogger(input.onLog) });
    await writeNewFile(input.outputFile, bytes, input.destinationSnapshot);
    const sha = sha256Bytes(bytes);
    return { ok: true, message: `Read ${bytes.byteLength} B to ${resolve(input.outputFile)}. sha256 ${sha}.`, steps, readbackSha256: sha, readbackPath: resolve(input.outputFile) };
  } catch (error) {
    return { ok: false, message: formatError(error), steps, readbackPath: resolve(input.outputFile) };
  }
}

export async function runCompareWorkflow(input: CompareWorkflowInput): Promise<WorkflowResult> {
  const steps: WorkflowStepResult[] = [];
  if (!input.file) return failPrecondition("Select a file before starting compare mode.");
  if (!input.chip) return failPrecondition("Select a chip before starting compare mode.");
  if (!input.confirmed) return failPrecondition("Confirm compare before starting.");
  if (!input.confirmedBytes) return failPrecondition("Freeze selected file bytes before confirming compare mode.");
  const local = input.confirmedBytes.slice();
  const localSha = input.confirmedSha256 ?? sha256Bytes(local);
  try {
    step(input, steps, "read chip for compare", true);
    const readback = await input.backend.readROM({ ...readOptions(input), onProgress: progressLogger(input.onLog) });
    const readbackSha = sha256Bytes(readback);
    if (!bytesEqual(local, readback)) {
      return { ok: false, message: `Compare failed. Local sha256 ${localSha}, chip sha256 ${readbackSha}.`, steps, originalSha256: localSha, readbackSha256: readbackSha };
    }
    return { ok: true, message: `Compare matched. sha256 ${localSha}.`, steps, originalSha256: localSha, readbackSha256: readbackSha };
  } catch (error) {
    return { ok: false, message: formatError(error), steps, originalSha256: localSha };
  }
}

export async function captureDestination(path: string): Promise<DestinationSnapshot> {
  try {
    const value = await stat(resolve(path));
    return { exists: true, device: value.dev, inode: value.ino, size: value.size, mtimeMs: value.mtimeMs };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { exists: false };
    throw error;
  }
}

async function writeNewFile(path: string, bytes: Uint8Array, snapshot: DestinationSnapshot): Promise<void> {
  if (snapshot.exists) throw new Error("Existing destination files are never replaced.");
  const destination = resolve(path);
  const file = await open(destination, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    await file.close();
    throw error;
  }
  await file.close();
  await syncDirectory(dirname(destination));
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (!isNodeError(error, "EINVAL") && !isNodeError(error, "ENOTSUP") && !isNodeError(error, "EISDIR")) throw error;
  }
}

function readOptions(input: CommonInput): ReadOptions {
  return {
    chip: input.chip!,
    programmerKind: input.programmerKind,
    skipIdCheck: input.advanced?.skipIdRead,
    continueOnIdMismatch: input.advanced?.ignoreIdMismatch,
    signal: input.signal,
  };
}

function step(input: CommonInput, steps: WorkflowStepResult[], name: string, cancellable: boolean): void {
  steps.push({ step: name });
  input.onStep?.(name, cancellable);
}

function progressLogger(onLog?: (line: string) => void): (event: BackendProgress) => void {
  let previous = "";
  return (event) => {
    const current = `${event.phase}:${event.offset}:${event.total}`;
    if (current === previous) return;
    previous = current;
    onLog?.(`${event.phase}: ${event.offset}/${event.total}`);
  };
}

function failPrecondition(message: string): WorkflowResult {
  return { ok: false, message, steps: [] };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
