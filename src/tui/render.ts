import type { AdvancedOptions, ChipInfo, FileEntry, JobState, ProgrammerKind, ProgrammerStatus } from "../types";
import { formatBytes } from "../files/scan";

export type StatusSummaryInput = {
  programmerStatus: ProgrammerStatus;
  database: ProgrammerKind;
  selectedChip?: string;
  selectedFile?: FileEntry;
  chipInfo?: ChipInfo;
  job: JobState;
  advanced: AdvancedOptions;
  fileCount: number;
  chipResultCount: number;
  showAllFiles: boolean;
};

export function formatStatusLine(input: {
  programmerStatus: ProgrammerStatus;
  database: ProgrammerKind;
  selectedChip?: string;
  selectedFile?: FileEntry;
  job: JobState;
}): string {
  const programmer = input.programmerStatus.connected ? `${input.programmerStatus.model ?? "connected"}` : "disconnected";
  const file = input.selectedFile ? `${input.selectedFile.name} ${input.selectedFile.size} B ${input.selectedFile.sha256Short}` : "none";
  const chip = input.selectedChip ?? "none";
  const job = input.job.kind === "running" ? input.job.step : input.job.kind;
  return ` minipro-tui | Programmer: ${programmer} | DB: ${input.database} | Chip: ${chip} | File: ${file} | ${job}`;
}

export function formatFileOption(file: FileEntry): { name: string; description: string; value: string } {
  return {
    name: file.name,
    description: `${file.size} B (${formatBytes(file.size)})  ${file.modifiedAt.toISOString().slice(0, 19)}  ${file.sha256Short}`,
    value: file.path,
  };
}

export function formatChipInfo(info?: ChipInfo): string {
  if (!info) return "Default chip query is AT28C64B. Select a chip search result to load chip info.";

  return [
    info.name || "Unknown",
    `Available on: ${info.availableOn ?? "unknown"}`,
    `Memory: ${info.memoryBytes === undefined ? "unknown" : `${info.memoryBytes} B`}`,
    `Package: ${info.packageName ?? "unknown"}`,
    `ICSP: ${info.icsp ?? "unknown"}`,
    `Protocol: ${info.protocol ?? "unknown"}`,
    `Read buffer: ${info.readBufferSize === undefined ? "unknown" : `${info.readBufferSize} B`}`,
    `Write buffer: ${info.writeBufferSize === undefined ? "unknown" : `${info.writeBufferSize} B`}`,
    "",
    info.raw,
  ].join("\n");
}

export function formatStatusSummary(input: StatusSummaryInput): string {
  const programmer = input.programmerStatus.connected ? (input.programmerStatus.model ?? "connected") : "disconnected";
  const chip = input.chipInfo
    ? `${input.chipInfo.name || input.selectedChip || "unknown"} | ${formatChipMemory(input.chipInfo)} | ${input.chipInfo.packageName ?? "package unknown"}`
    : input.selectedChip
      ? `${input.selectedChip} | load chip info before writing`
      : "none selected";
  const image = input.selectedFile ? `${input.selectedFile.name} | ${formatBytes(input.selectedFile.size)} | sha ${input.selectedFile.sha256Short}` : "none selected";
  const dangerous = formatDangerousOptions(input.advanced);

  return [
    formatFitLine(input),
    `Safety      ${dangerous.length > 0 ? `Review: ${dangerous.join(", ")}` : "Default safe write: erase, blank, write, verify, readback compare"}`,
    `Next        ${formatNextAction(input)}`,
    `Context     ${programmer} | DB ${input.database} | Files ${input.fileCount} | Chips ${input.chipResultCount} | ${chip} | ${image}`,
  ].join("\n");
}

function formatChipMemory(info: ChipInfo): string {
  return info.memoryBytes === undefined ? "size unknown" : formatBytes(info.memoryBytes);
}

function formatFitLine(input: StatusSummaryInput): string {
  if (!input.selectedFile || !input.selectedChip) return "Fit         Select a file and chip before writing";
  if (!input.chipInfo) return "Fit         Load chip info to check image size";
  if (input.chipInfo.memoryBytes === undefined) return "Fit         Chip memory size unknown";
  if (input.selectedFile.size === input.chipInfo.memoryBytes) return `Fit         OK: image matches chip memory (${formatBytes(input.selectedFile.size)})`;

  const mode = input.advanced.allowSizeMismatch ? "Override" : "Blocked";
  return `Fit         ${mode}: image ${formatBytes(input.selectedFile.size)} vs chip ${formatBytes(input.chipInfo.memoryBytes)}`;
}

function formatDangerousOptions(options: AdvancedOptions): string[] {
  return [
    options.allowSizeMismatch ? "size mismatch allowed" : undefined,
    options.disableReadbackCompare ? "readback compare off" : undefined,
    options.skipErase ? "erase skipped" : undefined,
    options.skipVerify ? "verify skipped" : undefined,
    options.ignoreIdMismatch ? "ID mismatch ignored" : undefined,
    options.skipIdRead ? "ID read skipped" : undefined,
  ].filter((item): item is string => item !== undefined);
}

function formatNextAction(input: StatusSummaryInput): string {
  if (input.job.kind === "running") return `Wait for ${input.job.step}`;
  if (!input.selectedChip) return "Search and select the target chip";
  if (!input.selectedFile) return "Select an image file, or press R to read the chip";
  if (!input.chipInfo) return "Select a chip result to load chip info";
  if (input.chipInfo.memoryBytes !== undefined && input.selectedFile.size !== input.chipInfo.memoryBytes && !input.advanced.allowSizeMismatch) {
    return "Use a matching image or explicitly allow size mismatch";
  }
  if (formatDangerousOptions(input.advanced).length > 0) return "Review advanced options, then press w to preview write";
  return "Press w to preview write, v verify, c pin check, R read";
}
