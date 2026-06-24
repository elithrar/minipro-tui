import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
import { parseProgrammerStatus } from "./parse";

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

export type DefaultWriteWorkflowInput = {
  file?: FileEntry;
  chip?: string;
  chipInfo?: ChipInfo;
  programmerKind: ProgrammerKind;
  confirmed: boolean;
  confirmedBytes?: Uint8Array;
  confirmedSha256?: string;
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

  const tempDir = await mkdtemp(join(tmpdir(), "minipro-tui-"));
  const confirmedWritePath = join(tempDir, basename(file.path));
  await writeFile(confirmedWritePath, originalBytes);
  const finish = async (result: WorkflowResult): Promise<WorkflowResult> => {
    if (!input.keepReadbackFile) await rm(tempDir, { recursive: true, force: true });
    return result;
  };

  input.onLog?.(`Selected ${basename(file.path)}: ${originalBytes.byteLength} B sha256 ${originalSha256}`);

  const connected = await runStep(steps, input.runCommand, "detect programmer", buildDetectProgrammerArgs());
  if (failed(connected)) return finish(fail("detect programmer", connected, steps, originalSha256));
  if (!parseProgrammerStatus(`${connected.stdout}\n${connected.stderr}`).connected) {
    return finish({ ok: false, message: "No connected programmer detected.", steps, originalSha256 });
  }

  const info = await runStep(steps, input.runCommand, "load chip info", buildChipInfoArgs(input.programmerKind, chip));
  if (failed(info)) return finish(fail("load chip info", info, steps, originalSha256));

  const pin = await runStep(steps, input.runCommand, "pin/contact check", buildPinCheckArgs(chip, advanced));
  if (failed(pin)) return finish(fail("pin/contact check", pin, steps, originalSha256));

  if (!advanced.skipErase) {
    const erase = await runStep(steps, input.runCommand, "erase", buildEraseArgs(chip, advanced));
    if (failed(erase)) return finish(fail("erase", erase, steps, originalSha256));
  }

  const blank = await runStep(steps, input.runCommand, "blank check", buildBlankCheckArgs(chip, advanced));
  if (failed(blank)) return finish(fail("blank check", blank, steps, originalSha256));

  const write = await runStep(steps, input.runCommand, "write", buildWriteArgs(chip, confirmedWritePath, advanced));
  if (failed(write)) return finish(fail("write", write, steps, originalSha256));

  if (!advanced.skipVerify) {
    const verify = await runStep(steps, input.runCommand, "verify", buildVerifyArgs(chip, confirmedWritePath, advanced));
    if (failed(verify)) return finish(fail("verify", verify, steps, originalSha256));
  }

  if (advanced.disableReadbackCompare) {
    return finish({ ok: true, message: `Write completed. Original sha256 ${originalSha256}. Readback compare disabled.`, steps, originalSha256 });
  }

  const readbackPath = join(tempDir, `${basename(file.path)}.readback`);
  const readback = await runStep(steps, input.runCommand, "readback", buildReadArgs(chip, readbackPath, advanced));
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
  const advanced = input.advanced ?? {};
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
    if (!input.keepReadbackFile) await rm(tempDir, { recursive: true, force: true });
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

  const steps: WorkflowStepResult[] = [];
  const connected = await runStep(steps, input.runCommand, "detect programmer", buildDetectProgrammerArgs());
  if (failed(connected)) return fail("detect programmer", connected, steps);
  if (!parseProgrammerStatus(`${connected.stdout}\n${connected.stderr}`).connected) {
    return { ok: false, message: "No connected programmer detected.", steps };
  }

  const read = await runStep(steps, input.runCommand, "read", buildReadArgs(input.chip, input.outputFile, advanced));
  if (failed(read)) return fail("read", read, steps, undefined, input.outputFile);

  const fileStat = await safeStat(input.outputFile);
  if (!fileStat.ok) return { ok: false, message: fileStat.message, steps, readbackPath: input.outputFile };

  const sha = await safeSha256File(input.outputFile, fileStat.size, fileStat.mtimeMs);
  if (!sha.ok) return { ok: false, message: sha.message, steps, readbackPath: input.outputFile };

  input.onLog?.(`Read ${fileStat.size} B to ${input.outputFile}. sha256 ${sha.value}`);
  return {
    ok: true,
    message: `Read completed. ${fileStat.size} B sha256 ${sha.value}.`,
    steps,
    readbackSha256: sha.value,
    readbackPath: input.outputFile,
  };
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
  const result = await runCommand(args, step);
  steps.push({ step, result });
  return result;
}

function failed(result: MiniproResult): boolean {
  return result.exitCode !== 0;
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
