import { StyledText, TextAttributes, stripAnsiSequences } from "@opentui/core";

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

export type StatusSummaryOptions = {
  width?: number;
};

const STATUS_LABEL_WIDTH = 7;

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

export function formatChipLabel(chip: string, info?: ChipInfo): { name: string; description: string; value: string } {
  const metadata = formatChipMetadata(info);
  const labelParts = [chip === "AT28C64B" ? "default" : undefined, metadata].filter((part): part is string => Boolean(part));
  return {
    name: labelParts.length > 0 ? `${chip} (${labelParts.join(", ")})` : chip,
    description: chip === "AT28C64B" ? "default" : "",
    value: chip,
  };
}

export function formatLogContent(lines: string[]): StyledText {
  const chunks = lines.map((line, index) => {
    const suffix = index === lines.length - 1 ? "" : "\n";
    return {
      __isChunk: true as const,
      text: `${sanitizeLogLine(line)}${suffix}`,
      attributes: isCommandLogLine(line) ? TextAttributes.BOLD : undefined,
    };
  });
  return new StyledText(chunks);
}

export function sanitizeLogLine(line: string): string {
  return stripAnsiSequences(line).replace(/[\u0000-\u001f\u007f]/g, "");
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

export function formatStatusSummary(input: StatusSummaryInput, options: StatusSummaryOptions = {}): string {
  const programmer = input.programmerStatus.connected ? (input.programmerStatus.model ?? "connected") : "disconnected";
  const chip = input.chipInfo
    ? `${input.chipInfo.name || input.selectedChip || "unknown"} | ${formatChipMemory(input.chipInfo)} | ${input.chipInfo.packageName ?? "package unknown"}`
    : input.selectedChip
      ? `${input.selectedChip} | load chip info before writing`
      : "none selected";
  const image = input.selectedFile ? `${input.selectedFile.name} | ${formatBytes(input.selectedFile.size)} | sha ${input.selectedFile.sha256Short}` : "none selected";
  const dangerous = formatDangerousOptions(input.advanced);
  const width = options.width === undefined ? undefined : Math.max(24, Math.floor(options.width));

  return [
    formatStatusRow("Fit", formatFitValue(input), width),
    formatStatusRow("Safety", dangerous.length > 0 ? `Review: ${dangerous.join(", ")}` : "Safe default: erase, blank, write, verify, compare", width),
    formatStatusRow("Next", formatNextAction(input), width),
    formatStatusRow("Device", `${programmer} | DB ${input.database}`, width),
    formatStatusRow("Files", `${input.fileCount}${input.showAllFiles ? " shown" : " found"} | Chips ${input.chipResultCount}`, width),
    formatStatusRow("Chip", chip, width),
    formatStatusRow("Image", image, width),
  ].join("\n");
}

function formatChipMemory(info: ChipInfo): string {
  return info.memoryBytes === undefined ? "size unknown" : formatBytes(info.memoryBytes);
}

function formatChipMetadata(info?: ChipInfo): string {
  if (!info) return "";

  const parts = [info.vcc ?? info.vdd ?? info.vpp, formatPackageName(info.packageName), info.pulseDelay].filter((part): part is string => Boolean(part));
  return parts.join(", ");
}

function formatPackageName(packageName?: string): string | undefined {
  const match = /^([A-Z]+)(\d+)$/i.exec(packageName ?? "");
  if (!match) return packageName;
  return `${match[2]} pin ${match[1]?.toUpperCase()}`;
}

function isCommandLogLine(line: string): boolean {
  return sanitizeLogLine(line).trimStart().startsWith("$ ");
}

function formatFitValue(input: StatusSummaryInput): string {
  if (!input.selectedFile || !input.selectedChip) return "Select a file and chip before writing";
  if (!input.chipInfo) return "Load chip info to check image size";
  if (input.chipInfo.memoryBytes === undefined) return "Chip memory size unknown";
  if (input.selectedFile.size === input.chipInfo.memoryBytes) return `OK: image matches chip memory (${formatBytes(input.selectedFile.size)})`;

  const mode = input.advanced.allowSizeMismatch ? "Override" : "Blocked";
  return `${mode}: image ${formatBytes(input.selectedFile.size)} vs chip ${formatBytes(input.chipInfo.memoryBytes)}`;
}

function formatStatusRow(label: string, value: string, width?: number): string {
  const prefix = `${label.padEnd(STATUS_LABEL_WIDTH)} `;
  if (width === undefined) return `${prefix}${value}`;

  const contentWidth = Math.max(12, width - prefix.length);
  return wrapWords(value, contentWidth)
    .map((line, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`)
    .join("\n");
}

function wrapWords(value: string, width: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (let word of words) {
    if (word.length > width) {
      if (line) {
        lines.push(line);
        line = "";
      }

      while (word.length > width) {
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
    }

    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
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
  return "w write preview | m compare | v verify | c pin check | R read";
}
