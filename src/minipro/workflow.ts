import { link, mkdtemp, open, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { AdvancedOptions, ChipInfo, FileEntry, MiniproResult, ProgrammerKind } from "../types";
import { sha256Bytes, sha256File } from "../files/hash";
import {
  buildBlankCheckArgs,
  buildChipInfoArgs,
  buildDetectProgrammerArgs,
  buildEraseArgs,
  buildPinCheckArgs,
  buildReadArgs,
  buildVerifyArgs,
  buildWriteArgs,
} from "./commands";
import { parseChipInfo, parseProgrammerStatus } from "./parse";

export type WorkflowCommandRunner = (args: string[], step: string) => Promise<MiniproResult>;

export type WorkflowStepResult = {
  step: string;
  result?: MiniproResult;
};

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

export type DefaultWriteWorkflowInput = {
  file?: FileEntry;
  chip?: string;
  chipInfo?: ChipInfo;
  programmerKind: ProgrammerKind;
  confirmed: boolean;
  confirmedBytes?: Uint8Array;
  confirmedSha256?: string;
  backupFile?: string;
  backupDestinationSnapshot?: DestinationSnapshot;
  advanced?: AdvancedOptions;
  runCommand: WorkflowCommandRunner;
  keepReadbackFile?: boolean;
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  onLog?: (line: string) => void;
};

export type ReadWorkflowInput = {
  chip?: string;
  outputFile?: string;
  confirmed: boolean;
  advanced?: AdvancedOptions;
  runCommand: WorkflowCommandRunner;
  onLog?: (line: string) => void;
  destinationSnapshot: DestinationSnapshot;
};

export type CompareWorkflowInput = {
  file?: FileEntry;
  chip?: string;
  confirmed: boolean;
  confirmedBytes?: Uint8Array;
  confirmedSha256?: string;
  advanced?: AdvancedOptions;
  runCommand: WorkflowCommandRunner;
  keepReadbackFile?: boolean;
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  onLog?: (line: string) => void;
};

export async function runDefaultWriteWorkflow(input: DefaultWriteWorkflowInput): Promise<WorkflowResult> {
  const advanced = input.advanced ?? {};
  const preconditionError = validateWorkflowInput(input.file, input.chip, input.chipInfo, input.confirmed, advanced.allowSizeMismatch, input.confirmedBytes?.byteLength);
  if (preconditionError) return { ok: false, message: preconditionError, steps: [] };

  const file = input.file;
  const chip = input.chip;
  const chipInfo = input.chipInfo;
  if (!file || !chip || !chipInfo) return { ok: false, message: "Missing workflow input.", steps: [] };
  if (!input.confirmedBytes) return { ok: false, message: "Freeze selected file bytes before confirming the write flow.", steps: [] };

  const steps: WorkflowStepResult[] = [];
  const load = input.readFileBytes ?? readFile;
  const originalBytes = input.confirmedBytes;
  const originalSha256 = input.confirmedSha256 ?? sha256Bytes(originalBytes);
  const workflowOptions: AdvancedOptions = { ...advanced, fileFormat: undefined };
  const backupDestinationSnapshot = input.backupDestinationSnapshot;

  if (input.backupFile && !backupDestinationSnapshot) return { ok: false, message: "Capture the backup destination before confirmation.", steps: [], originalSha256 };
  if (backupDestinationSnapshot?.exists) return { ok: false, message: "Choose a new backup filename; existing files are never replaced.", steps: [], originalSha256 };

  const tempDir = await mkdtemp(join(tmpdir(), "minipro-tui-"));
  let backupTempDirectory: string | undefined;
  const confirmedWritePath = join(tempDir, `${basename(file.path)}.confirmed.bin`);
  try {
    await writeFile(confirmedWritePath, originalBytes);
  } catch (error) {
    await removeBestEffort(tempDir);
    return { ok: false, message: `Cannot prepare confirmed write image: ${formatError(error)}`, steps: [], originalSha256 };
  }
  const finish = async (result: WorkflowResult): Promise<WorkflowResult> => {
    if (backupTempDirectory) await removeBestEffort(backupTempDirectory);
    if (!input.keepReadbackFile) await removeBestEffort(tempDir);
    return result;
  };

  input.onLog?.(`Selected ${basename(file.path)}: ${originalBytes.byteLength} B sha256 ${originalSha256}`);

  const connected = await runStep(steps, input.runCommand, "detect programmer", buildDetectProgrammerArgs());
  if (failed(connected)) return finish(fail("detect programmer", connected, steps, originalSha256));
  if (!parseProgrammerStatus(`${connected.stdout}\n${connected.stderr}`).connected) {
    return finish({ ok: false, message: "No connected programmer detected.", steps, originalSha256 });
  }
  const detectedKind = parseProgrammerStatus(`${connected.stdout}\n${connected.stderr}`).kind;
  if (!detectedKind) {
    return finish({ ok: false, message: "Connected programmer model is not recognized; refusing to use a different database for destructive work.", steps, originalSha256 });
  }
  if (detectedKind && detectedKind !== input.programmerKind) {
    return finish({ ok: false, message: `Connected programmer ${detectedKind} does not match confirmed database ${input.programmerKind}.`, steps, originalSha256 });
  }

  const info = await runStep(steps, input.runCommand, "load chip info", buildChipInfoArgs(input.programmerKind, chip));
  if (failed(info)) return finish(fail("load chip info", info, steps, originalSha256));
  const infoOutput = commandText(info);
  if (!infoOutput.trim()) return finish({ ok: false, message: "Live chip information was empty.", steps, originalSha256 });
  const liveChipInfo = parseChipInfo(infoOutput);
  if (liveChipInfo.memoryBytes === undefined && !advanced.allowSizeMismatch) {
    return finish({ ok: false, message: "Could not determine live chip memory size. Enable the explicit size override only after verifying the device manually.", steps, originalSha256 });
  }
  if (chipInfo.memoryBytes !== undefined && liveChipInfo.memoryBytes !== undefined && chipInfo.memoryBytes !== liveChipInfo.memoryBytes) {
    return finish({ ok: false, message: "Chip information changed after confirmation.", steps, originalSha256 });
  }
  if (liveChipInfo.memoryBytes !== undefined && liveChipInfo.memoryBytes !== originalBytes.byteLength && !advanced.allowSizeMismatch) {
    return finish({ ok: false, message: `Confirmed image size ${originalBytes.byteLength} B does not match live chip memory size ${liveChipInfo.memoryBytes} B.`, steps, originalSha256 });
  }

  const pin = await runStep(steps, input.runCommand, "pin/contact check", buildPinCheckArgs(chip, workflowOptions));
  if (failed(pin)) return finish(fail("pin/contact check", pin, steps, originalSha256));
  if (isPinCheckUnsupported(commandText(pin)) && !advanced.allowUnsupportedPinCheck) {
    return finish({ ok: false, message: "Pin/contact check is not supported for this programmer and chip. Enable the explicit override only after manually checking placement and contact.", steps, originalSha256 });
  }

  if (input.backupFile) {
    if (!backupDestinationSnapshot) return finish({ ok: false, message: "Capture the backup destination before confirmation.", steps, originalSha256 });
    const backupDestination = resolve(input.backupFile);
    const temp = await createReadTempPath(backupDestination);
    if (!temp.ok) return finish({ ok: false, message: temp.message, steps, originalSha256 });
    backupTempDirectory = temp.directory;
    const backup = await runStep(steps, input.runCommand, "backup existing chip", buildReadArgs(chip, temp.path, workflowOptions));
    if (failed(backup)) return finish(fail("backup existing chip", backup, steps, originalSha256, backupDestination));
    const backupStat = await safeStat(temp.path);
    if (!backupStat.ok) return finish({ ok: false, message: backupStat.message, steps, originalSha256, readbackPath: backupDestination });
    const backupSha = await safeSha256File(temp.path, backupStat.size, backupStat.mtimeMs);
    if (!backupSha.ok) return finish({ ok: false, message: backupSha.message, steps, originalSha256, readbackPath: backupDestination });
    try {
      await commitFile(temp.path, backupDestination, backupDestinationSnapshot);
    } catch (error) {
      return finish({ ok: false, message: `Cannot replace backup destination: ${formatError(error)}`, steps, originalSha256, readbackPath: backupDestination });
    }
    input.onLog?.(`Backed up ${backupStat.size} B to ${backupDestination}. sha256 ${backupSha.value}`);
  }

  if (!advanced.skipErase) {
    const erase = await runStep(steps, input.runCommand, "erase", buildEraseArgs(chip, workflowOptions));
    if (failed(erase)) return finish(fail("erase", erase, steps, originalSha256));
  }

  const blank = await runStep(steps, input.runCommand, "blank check", buildBlankCheckArgs(chip, workflowOptions));
  if (failed(blank)) return finish(fail("blank check", blank, steps, originalSha256));

  const write = await runStep(steps, input.runCommand, "write", buildWriteArgs(chip, confirmedWritePath, { ...workflowOptions, skipErase: true, skipVerify: true }));
  if (failed(write)) return finish(fail("write", write, steps, originalSha256));

  if (!advanced.skipVerify) {
    const verify = await runStep(steps, input.runCommand, "verify", buildVerifyArgs(chip, confirmedWritePath, workflowOptions));
    if (failed(verify)) return finish(fail("verify", verify, steps, originalSha256));
  }

  if (advanced.disableReadbackCompare) {
    return finish({ ok: true, message: `Write completed. Original sha256 ${originalSha256}. Readback compare disabled.`, steps, originalSha256 });
  }

  const readbackPath = join(tempDir, `${basename(file.path)}.readback`);
  const readback = await runStep(steps, input.runCommand, "readback", buildReadArgs(chip, readbackPath, workflowOptions));
  if (failed(readback)) {
    return finish(fail("readback", readback, steps, originalSha256, readbackPath));
  }

  const loaded = await safeLoadReadback(load, readbackPath);
  if (!loaded.ok) {
    return finish({ ok: false, message: loaded.message, steps, originalSha256, readbackPath });
  }
  const readbackBytes = loaded.readbackBytes;
  const readbackSha256 = sha256Bytes(readbackBytes);
  const matches = Buffer.compare(Buffer.from(originalBytes), Buffer.from(readbackBytes)) === 0;

  if (!matches) {
    return finish({
      ok: false,
      message: `Readback compare failed. Original sha256 ${originalSha256}, readback sha256 ${readbackSha256}.`,
      steps,
      originalSha256,
      readbackSha256,
      readbackPath,
    });
  }

  return finish({
    ok: true,
    message: `Write, verify, and readback compare completed. sha256 ${originalSha256}.`,
    steps,
    originalSha256,
    readbackSha256,
    readbackPath,
  });
}

export async function runCompareWorkflow(input: CompareWorkflowInput): Promise<WorkflowResult> {
  const advanced: AdvancedOptions = { ...(input.advanced ?? {}), fileFormat: undefined };
  if (!input.file) return { ok: false, message: "Select a file before starting compare mode.", steps: [] };
  if (!input.chip) return { ok: false, message: "Select a chip before starting compare mode.", steps: [] };
  if (!input.confirmed) return { ok: false, message: "Confirm compare before starting.", steps: [] };
  if (!input.confirmedBytes) return { ok: false, message: "Freeze selected file bytes before confirming compare mode.", steps: [] };

  const steps: WorkflowStepResult[] = [];
  const load = input.readFileBytes ?? readFile;
  const localSha256 = input.confirmedSha256 ?? sha256Bytes(input.confirmedBytes);

  const tempDir = await mkdtemp(join(tmpdir(), "minipro-tui-compare-"));
  const readbackPath = join(tempDir, `${basename(input.file.path)}.chip-readback`);
  const finish = async (result: WorkflowResult): Promise<WorkflowResult> => {
    if (!input.keepReadbackFile) await removeBestEffort(tempDir);
    return result;
  };

  input.onLog?.(`Compare local ${basename(input.file.path)}: ${input.confirmedBytes.byteLength} B sha256 ${localSha256}`);

  const connected = await runStep(steps, input.runCommand, "detect programmer", buildDetectProgrammerArgs());
  if (failed(connected)) return finish(fail("detect programmer", connected, steps, localSha256, readbackPath));
  if (!parseProgrammerStatus(`${connected.stdout}\n${connected.stderr}`).connected) {
    return finish({ ok: false, message: `No connected programmer detected. Local sha256 ${localSha256}.`, steps, originalSha256: localSha256, readbackPath });
  }

  const read = await runStep(steps, input.runCommand, "read chip for compare", buildReadArgs(input.chip, readbackPath, advanced));
  if (failed(read)) return finish(fail("read chip for compare", read, steps, localSha256, readbackPath));

  const loaded = await safeLoadReadback(load, readbackPath);
  if (!loaded.ok) {
    return finish({ ok: false, message: `${loaded.message}. Local sha256 ${localSha256}.`, steps, originalSha256: localSha256, readbackPath });
  }

  const chipSha256 = sha256Bytes(loaded.readbackBytes);
  const matched = localSha256 === chipSha256;
  const status = matched ? "matched" : "files do not match";
  input.onLog?.(`Compare chip readback: ${loaded.readbackBytes.byteLength} B sha256 ${chipSha256}`);

  return finish({
    ok: matched,
    message: `Compare ${status}. Local sha256 ${localSha256}. Chip sha256 ${chipSha256}.`,
    steps,
    originalSha256: localSha256,
    readbackSha256: chipSha256,
    readbackPath,
  });
}

export async function runReadWorkflow(input: ReadWorkflowInput): Promise<WorkflowResult> {
  const advanced = input.advanced ?? {};
  if (!input.chip) return { ok: false, message: "Select a chip before reading.", steps: [] };
  if (!input.outputFile) return { ok: false, message: "Choose an output filename before reading.", steps: [] };
  if (!input.confirmed) return { ok: false, message: "Confirm read before starting.", steps: [] };
  if (!input.destinationSnapshot) return { ok: false, message: "Capture the read destination before confirmation.", steps: [] };
  if (input.destinationSnapshot.exists) return { ok: false, message: "Choose a new read filename; existing files are never replaced.", steps: [] };

  const steps: WorkflowStepResult[] = [];
  const destination = resolve(input.outputFile);
  const temp = await createReadTempPath(destination);
  if (!temp.ok) return { ok: false, message: temp.message, steps };
  const finish = async (result: WorkflowResult): Promise<WorkflowResult> => {
    await removeBestEffort(temp.directory);
    return result;
  };

  const connected = await runStep(steps, input.runCommand, "detect programmer", buildDetectProgrammerArgs());
  if (failed(connected)) return finish(fail("detect programmer", connected, steps));
  if (!parseProgrammerStatus(`${connected.stdout}\n${connected.stderr}`).connected) {
    return finish({ ok: false, message: "No connected programmer detected.", steps });
  }

  const read = await runStep(steps, input.runCommand, "read", buildReadArgs(input.chip, temp.path, advanced));
  if (failed(read)) return finish(fail("read", read, steps, undefined, destination));

  const fileStat = await safeStat(temp.path);
  if (!fileStat.ok) return finish({ ok: false, message: fileStat.message, steps, readbackPath: destination });

  const sha = await safeSha256File(temp.path, fileStat.size, fileStat.mtimeMs);
  if (!sha.ok) return finish({ ok: false, message: sha.message, steps, readbackPath: destination });

  try {
    await commitFile(temp.path, destination, input.destinationSnapshot);
  } catch (error) {
    return finish({ ok: false, message: `Cannot replace read destination: ${formatError(error)}`, steps, readbackPath: destination });
  }

  input.onLog?.(`Read ${fileStat.size} B to ${destination}. sha256 ${sha.value}`);
  return finish({
    ok: true,
    message: `Read completed. ${fileStat.size} B sha256 ${sha.value}.`,
    steps,
    readbackSha256: sha.value,
    readbackPath: destination,
  });
}

async function createReadTempPath(destination: string): Promise<{ ok: true; directory: string; path: string } | { ok: false; message: string }> {
  try {
    const directory = await mkdtemp(join(dirname(destination), ".minipro-tui-read-"));
    return { ok: true, directory, path: join(directory, basename(destination)) };
  } catch (error) {
    return { ok: false, message: `Cannot prepare read destination: ${formatError(error)}` };
  }
}

export async function captureDestination(path: string): Promise<DestinationSnapshot> {
  try {
    const value = await stat(path);
    return { exists: true, device: value.dev, inode: value.ino, size: value.size, mtimeMs: value.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function commitFile(source: string, destination: string, expected: DestinationSnapshot): Promise<void> {
  const sourceHandle = await open(source, "r");
  try {
    await sourceHandle.sync();
  } finally {
    await sourceHandle.close();
  }

  if (expected.exists) throw new Error("Existing destinations are never replaced.");
  await link(source, destination);
  await unlink(source);

  try {
    const directoryHandle = await open(dirname(destination), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM" || code === "EACCES";
}

async function safeStat(path: string): Promise<{ ok: true; size: number; mtimeMs: number } | { ok: false; message: string }> {
  try {
    const fileStat = await stat(path);
    return { ok: true, size: fileStat.size, mtimeMs: fileStat.mtimeMs };
  } catch (error) {
    return { ok: false, message: `Cannot read selected file metadata: ${formatError(error)}` };
  }
}

async function safeSha256File(path: string, size: number, mtimeMs: number): Promise<{ ok: true; value: string } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await sha256File(path, size, mtimeMs) };
  } catch (error) {
    return { ok: false, message: `Cannot hash selected file: ${formatError(error)}` };
  }
}

async function safeLoadReadback(
  load: (path: string) => Promise<Uint8Array>,
  readbackPath: string,
): Promise<{ ok: true; readbackBytes: Uint8Array } | { ok: false; message: string }> {
  try {
    return { ok: true, readbackBytes: await load(readbackPath) };
  } catch (error) {
    return { ok: false, message: `Cannot compare readback file: ${formatError(error)}` };
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateWorkflowInput(
  file: FileEntry | undefined,
  chip: string | undefined,
  chipInfo: ChipInfo | undefined,
  confirmed: boolean,
  allowSizeMismatch: boolean | undefined,
  confirmedSize: number | undefined,
): string | undefined {
  if (!file) return "Select a file before starting the write flow.";
  if (!chip) return "Select a chip before starting the write flow.";
  if (!chipInfo) return "Load chip info before starting the write flow.";
  if (!confirmed) return "Confirm erase and write before starting the write flow.";
  if (chipInfo.memoryBytes === undefined && !allowSizeMismatch) return "Chip memory size is unknown. Confirm it manually before enabling the size override.";
  const size = confirmedSize ?? file.size;
  if (chipInfo.memoryBytes !== undefined && size !== chipInfo.memoryBytes && !allowSizeMismatch) {
    return `File size ${size} B does not match chip memory size ${chipInfo.memoryBytes} B.`;
  }
  return undefined;
}

async function runStep(
  steps: WorkflowStepResult[],
  runCommand: WorkflowCommandRunner,
  step: string,
  args: string[],
): Promise<MiniproResult> {
  let result: MiniproResult;
  try {
    result = await runCommand(args, step);
  } catch (error) {
    result = { command: ["minipro", ...args], exitCode: null, stdout: "", stderr: formatError(error), durationMs: 0 };
  }
  steps.push({ step, result });
  return result;
}

function failed(result: MiniproResult): boolean {
  return result.exitCode !== 0 || result.aborted === true;
}

async function removeBestEffort(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    // Cleanup must not replace the result of a completed hardware operation.
  }
}

function fail(
  step: string,
  result: MiniproResult,
  steps: WorkflowStepResult[],
  originalSha256?: string,
  readbackPath?: string,
): WorkflowResult {
  return {
    ok: false,
    message: `${step} failed with exit ${result.exitCode ?? "signal/error"}.`,
    steps,
    originalSha256,
    readbackPath,
  };
}

function commandText(result: MiniproResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function isPinCheckUnsupported(output: string): boolean {
  return /pin test is not supported|pin.*check.*not supported/i.test(output);
}
