import { spawn } from "node:child_process";

import type { AdvancedOptions, MiniproResult, ProgrammerKind } from "../types";

export type RunMiniproOptions = {
  binary?: string;
  onLog?: (line: string) => void;
};

export function databaseArg(kind: ProgrammerKind): string {
  switch (kind) {
    case "tl866a":
      return "TL866A";
    case "tl866ii":
      return "TL866II";
    case "t48":
      return "T48";
    case "t56":
      return "T56";
  }
}

export function buildListProgrammersArgs(): string[] {
  return ["-Q"];
}

export function buildDetectProgrammerArgs(): string[] {
  return ["-k"];
}

export function buildSearchChipsArgs(kind: ProgrammerKind, query: string): string[] {
  return ["-q", databaseArg(kind), "-L", query];
}

export function buildChipInfoArgs(kind: ProgrammerKind, chip: string): string[] {
  return ["-q", databaseArg(kind), "-d", chip];
}

export function buildPinCheckArgs(chip: string, options: AdvancedOptions = {}): string[] {
  return withAdvancedOptions(["-p", chip, "-z"], options);
}

export function buildBlankCheckArgs(chip: string, options: AdvancedOptions = {}): string[] {
  return withAdvancedOptions(["-p", chip, "-b"], options);
}

export function buildEraseArgs(chip: string, options: AdvancedOptions = {}): string[] {
  return withAdvancedOptions(["-p", chip, "-E"], options);
}

export function buildWriteArgs(chip: string, file: string, options: AdvancedOptions = {}): string[] {
  return withAdvancedOptions(["-p", chip, "-w", file], options);
}

export function buildVerifyArgs(chip: string, file: string, options: AdvancedOptions = {}): string[] {
  return withAdvancedOptions(["-p", chip, "-m", file], options);
}

export function buildReadArgs(chip: string, outputFile: string, options: AdvancedOptions = {}): string[] {
  return withAdvancedOptions(["-p", chip, "-r", outputFile], options);
}

export function buildDefaultWritePreview(chip: string, file: string, kind: ProgrammerKind, options: AdvancedOptions = {}): string[][] {
  const commands = [
    buildDetectProgrammerArgs(),
    buildChipInfoArgs(kind, chip),
    buildPinCheckArgs(chip, options),
  ];

  if (!options.skipErase) commands.push(buildEraseArgs(chip, options));
  commands.push(buildBlankCheckArgs(chip, options), buildWriteArgs(chip, file, options));

  if (!options.skipVerify) commands.push(buildVerifyArgs(chip, file, options));
  if (!options.disableReadbackCompare) commands.push(buildReadArgs(chip, "<temp-readback-file>", options));

  return commands;
}

export function withAdvancedOptions(args: string[], options: AdvancedOptions): string[] {
  const result = [...args];

  if (options.memoryType) result.push("-c", options.memoryType);
  if (options.fileFormat) result.push("-f", options.fileFormat);
  if (options.vpp) result.push("--vpp", options.vpp);
  if (options.vdd) result.push("--vdd", options.vdd);
  if (options.vcc) result.push("--vcc", options.vcc);
  if (options.pulseDelay) result.push("--pulse", options.pulseDelay);
  if (options.spiSpeed) result.push("--speed", options.spiSpeed);
  if (options.unprotect) result.push("--unprotect");
  if (options.protect) result.push("--protect");
  if (options.icspVcc) result.push("--icsp_vcc");
  if (options.icspNoVcc) result.push("--icsp_no_vcc");

  if (options.skipErase) result.push("--skip_erase");
  if (options.skipVerify) result.push("--skip_verify");
  if (options.allowSizeMismatch) result.push("--no_size_error");
  if (options.ignoreIdMismatch) result.push("--no_id_error");
  if (options.skipIdRead) result.push("--skip_id");

  return result;
}

export function runMinipro(args: string[], options: RunMiniproOptions = {}): Promise<MiniproResult> {
  const binary = options.binary ?? process.env.MINIPRO_BIN ?? "minipro";
  const command = [binary, ...args];
  const start = performance.now();

  options.onLog?.(`$ ${JSON.stringify(command)}`);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      const durationMs = Math.round(performance.now() - start);
      const result = { command, exitCode, stdout, stderr, durationMs };
      if (stdout.trim()) options.onLog?.(stdout.trimEnd());
      if (stderr.trim()) options.onLog?.(stderr.trimEnd());
      options.onLog?.(`exit ${exitCode ?? "signal/error"} in ${durationMs}ms`);
      resolve(result);
    };

    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
