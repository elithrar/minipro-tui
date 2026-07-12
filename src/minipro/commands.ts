import { spawn } from "node:child_process";

import type { AdvancedOptions, MiniproResult, ProgrammerKind } from "../types";

export type RunMiniproOptions = {
  binary?: string;
  onLog?: (line: string) => void;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  terminateGraceMs?: number;
};

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TERMINATE_GRACE_MS = 2000;

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
  return withHardwareOptions(["-p", chip, "-z"], options);
}

export function buildBlankCheckArgs(chip: string, options: AdvancedOptions = {}): string[] {
  return withMemoryOptions(["-p", chip, "-b"], options);
}

export function buildEraseArgs(chip: string, options: AdvancedOptions = {}): string[] {
  return withMemoryOptions(["-p", chip, "-E"], options);
}

export function buildWriteArgs(chip: string, file: string, options: AdvancedOptions = {}): string[] {
  const result = withFileOptions(withMemoryOptions(["-p", chip, "-w", file], options), options);
  if (options.vpp) result.push("--vpp", stripUnit(options.vpp, /v$/i));
  if (options.vdd) result.push("--vdd", stripUnit(options.vdd, /v$/i));
  if (options.vcc) result.push("--vcc", stripUnit(options.vcc, /v$/i));
  if (options.pulseDelay) result.push("--pulse", stripUnit(options.pulseDelay, /us$/i));
  if (options.spiSpeed) result.push("--speed", options.spiSpeed.trim());
  if (options.unprotect) result.push("--unprotect");
  if (options.skipErase) result.push("--skip_erase");
  if (options.skipVerify) result.push("--skip_verify");
  if (options.allowSizeMismatch) result.push("--no_size_error");
  return result;
}

export function buildVerifyArgs(chip: string, file: string, options: AdvancedOptions = {}): string[] {
  const result = withFileOptions(withMemoryOptions(["-p", chip, "-m", file], options), options);
  if (options.allowSizeMismatch) result.push("--no_size_error");
  return result;
}

export function buildReadArgs(chip: string, outputFile: string, options: AdvancedOptions = {}): string[] {
  const result = withFileOptions(withMemoryOptions(["-p", chip, "-r", outputFile], { ...options, memoryType: options.memoryType ?? "code" }), options);
  if (options.skipIdRead) result.push("--skip_id");
  return result;
}

export function buildDefaultWritePreview(chip: string, file: string, kind: ProgrammerKind, options: AdvancedOptions = {}, backupFile?: string): string[][] {
  const writeOptions = { ...options, unprotect: true };
  const commands = [
    buildDetectProgrammerArgs(),
    buildChipInfoArgs(kind, chip),
    buildPinCheckArgs(chip, options),
  ];

  if (backupFile) commands.push(buildReadArgs(chip, backupFile, options));
  if (!options.skipErase) commands.push(buildEraseArgs(chip, options));
  commands.push(buildBlankCheckArgs(chip, options), buildWriteArgs(chip, file, writeOptions));

  if (!options.skipVerify) commands.push(buildVerifyArgs(chip, file, options));
  if (!options.disableReadbackCompare) commands.push(buildReadArgs(chip, "<temp-readback-file>", options));

  return commands;
}

function withHardwareOptions(args: string[], options: AdvancedOptions): string[] {
  const result = [...args];
  if (options.icspVcc) result.push("--icsp_vcc");
  if (options.icspNoVcc) result.push("--icsp_no_vcc");
  if (options.ignoreIdMismatch) result.push("--no_id_error");
  return result;
}

function withMemoryOptions(args: string[], options: AdvancedOptions): string[] {
  const result = withHardwareOptions(args, options);
  if (options.memoryType) result.push("-c", options.memoryType);
  return result;
}

function withFileOptions(args: string[], options: AdvancedOptions): string[] {
  const result = [...args];
  if (options.fileFormat) result.push("-f", options.fileFormat);
  return result;
}

function stripUnit(value: string, unit: RegExp): string {
  return value.trim().replace(unit, "");
}

export function runMinipro(args: string[], options: RunMiniproOptions = {}): Promise<MiniproResult> {
  const binary = options.binary ?? process.env.MINIPRO_BIN ?? "minipro";
  const command = [binary, ...args];
  const start = performance.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  options.onLog?.(`$ ${JSON.stringify(command)}`);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let stdoutPending = "";
    let stderrPending = "";
    let aborted = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", abort);
      if (stdoutPending) options.onLog?.(stdoutPending);
      if (stderrPending) options.onLog?.(stderrPending);
      const durationMs = Math.round(performance.now() - start);
      const effectiveExitCode = aborted || outputLimitExceeded ? null : exitCode;
      const result = { command, exitCode: effectiveExitCode, stdout, stderr, durationMs, aborted };
      options.onLog?.(`exit ${effectiveExitCode ?? "signal/error"} in ${durationMs}ms`);
      resolve(result);
    };

    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });

    const killProcessTree = (signal: NodeJS.Signals) => {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        killer.on("error", () => child.kill(signal));
        return;
      }
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to the direct child if the process group has already exited.
        }
      }
      child.kill(signal);
    };

    const terminate = () => {
      if (forceKillTimer) return;
      killProcessTree("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) killProcessTree("SIGKILL");
      }, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS);
    };

    const abort = () => {
      if (settled || aborted) return;
      aborted = true;
      const message = "minipro command cancelled by operator.";
      stderr += `${stderr ? "\n" : ""}${message}`;
      options.onLog?.(message);
      terminate();
    };

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const capture = (chunk: string, stream: "stdout" | "stderr") => {
      if (outputLimitExceeded) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        const message = `minipro output exceeded ${maxOutputBytes} bytes; process terminated.`;
        stderr += `${stderr ? "\n" : ""}${message}`;
        options.onLog?.(message);
        terminate();
        return;
      }

      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;

      const pending = (stream === "stdout" ? stdoutPending : stderrPending) + chunk;
      const parts = pending.split(/\r\n|\n|\r/);
      const tail = parts.pop() ?? "";
      for (const line of parts) if (line) options.onLog?.(line);
      if (stream === "stdout") stdoutPending = tail;
      else stderrPending = tail;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk: string) => capture(chunk, "stderr"));
    child.on("error", (error) => {
      stderr += error.message;
      options.onLog?.(error.message);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
