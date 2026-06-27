import { RGBA, StyledText, TextAttributes, stripAnsiSequences } from "@opentui/core";

import type { AdvancedOptions, ChipInfo, FileEntry, FileTreeEntry, JobState, ProgrammerKind, ProgrammerStatus } from "../types";
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

const STATUS_LABEL_WIDTH = 8;
const COMMAND_LOG_BG = RGBA.fromHex("#282828");
const COMMAND_LOG_FG = RGBA.fromHex("#fab283");
const DANGEROUS_OFF_BG = RGBA.fromHex("#5a1f1f");

export function formatStatusLine(input: {
  programmerStatus: ProgrammerStatus;
  database: ProgrammerKind;
  selectedChip?: string;
  selectedFile?: FileEntry;
  job: JobState;
}): string {
  const programmer = input.programmerStatus.connected ? (input.programmerStatus.model ?? "connected") : "disconnected";
  const file = input.selectedFile ? truncateMiddle(input.selectedFile.name, 30) : "no file";
  const chip = input.selectedChip ? truncateMiddle(input.selectedChip, 24) : "no chip";
  const job = input.job.kind === "running" ? input.job.step : input.job.kind;
  return ` minipro-tui | ${programmer} | ${input.database} | ${chip} | ${file} | ${job}`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const marker = "...";
  const half = Math.floor((maxLength - marker.length) / 2);
  return `${value.slice(0, half)}${marker}${value.slice(value.length - (maxLength - half - marker.length))}`;
}

export function formatFileOption(file: FileEntry): { name: string; description: string; value: string } {
  return {
    name: file.name,
    description: `${file.size} B (${formatBytes(file.size)})  ${file.modifiedAt.toISOString().slice(0, 19)}  ${file.sha256Short}`,
    value: file.path,
  };
}

export function formatFileTreeOption(entry: FileTreeEntry): { name: string; description: string; value: string } {
  if (entry.kind === "directory") {
    return {
      name: entry.name === ".." ? "../" : `${entry.name}/`,
      description: "directory",
      value: entry.path,
    };
  }

  return formatFileOption(entry);
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
    const command = isCommandLogLine(line);
    return {
      __isChunk: true as const,
      text: `${sanitizeLogLine(line)}${suffix}`,
      fg: command ? COMMAND_LOG_FG : undefined,
      bg: command ? COMMAND_LOG_BG : undefined,
      attributes: command ? TextAttributes.BOLD : undefined,
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
  const width = options.width === undefined ? undefined : Math.max(24, Math.floor(options.width));
  return statusRows(input).map((row) => formatStatusRow(row.label, row.value, width)).join("\n");
}

export function formatStatusSummaryContent(input: StatusSummaryInput, options: StatusSummaryOptions = {}): StyledText {
  const width = options.width === undefined ? undefined : Math.max(24, Math.floor(options.width));
  const chunks = statusRows(input).flatMap((row, index, rows) => formatStatusRowChunks(row, width, index < rows.length - 1));
  return new StyledText(chunks);
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
  if (!input.selectedFile || !input.selectedChip) return "WAIT select file+chip";
  if (!input.chipInfo) return "WAIT load chip info";
  if (input.chipInfo.memoryBytes === undefined) return "WARN chip size unknown";
  if (input.selectedFile.size === input.chipInfo.memoryBytes) return `OK ${formatBytes(input.selectedFile.size)}`;

  const mode = input.advanced.allowSizeMismatch ? "Override" : "Blocked";
  return `${mode.toUpperCase()} ${formatBytes(input.selectedFile.size)} vs ${formatBytes(input.chipInfo.memoryBytes)}`;
}

function formatStatusRow(label: string, value: string, width?: number): string {
  const prefix = `${label.padEnd(STATUS_LABEL_WIDTH)} `;
  return truncateEnd(`${prefix}${value}`, width ?? Number.MAX_SAFE_INTEGER);
}

function formatStatusRowChunks(row: StatusRow, width: number | undefined, newline: boolean): StyledText["chunks"] {
  const prefix = `${row.label.padEnd(STATUS_LABEL_WIDTH)} `;
  const available = width === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, width - prefix.length);
  const value = truncateEnd(row.value, available);
  const suffix = newline ? "\n" : "";
  const chunks: StyledText["chunks"] = [{ __isChunk: true, text: prefix }];

  if (row.stage === "on") {
    chunks.push({ __isChunk: true, text: value, attributes: TextAttributes.BOLD });
  } else if (row.stage === "danger-off") {
    chunks.push({ __isChunk: true, text: value, fg: RGBA.fromHex("#ffffff"), bg: DANGEROUS_OFF_BG, attributes: TextAttributes.BOLD });
  } else {
    chunks.push({ __isChunk: true, text: value });
  }

  if (suffix) chunks.push({ __isChunk: true, text: suffix });
  return chunks;
}

type StatusRow = {
  label: string;
  value: string;
  stage?: "on" | "danger-off";
};

function statusRows(input: StatusSummaryInput): StatusRow[] {
  const programmer = input.programmerStatus.connected ? (input.programmerStatus.model ?? "connected") : "disconnected";
  return [
    { label: "Fit", value: formatFitValue(input) },
    stageRow("Erase", !input.advanced.skipErase, true),
    stageRow("Blank", true, false),
    stageRow("Write", true, false),
    stageRow("Verify", !input.advanced.skipVerify, true),
    stageRow("Compare", !input.advanced.disableReadbackCompare, true),
    { label: "Device", value: `${programmer} / ${input.database}` },
    { label: "Chip", value: formatChipStatus(input) },
    { label: "Image", value: formatImageStatus(input) },
    { label: "Safety", value: formatSafetyStatus(input) },
  ];
}

function stageRow(label: string, enabled: boolean, dangerousWhenOff: boolean): StatusRow {
  return { label, value: stageState(enabled), stage: enabled ? "on" : dangerousWhenOff ? "danger-off" : undefined };
}

function stageState(enabled: boolean): string {
  return enabled ? "ON" : "OFF";
}

function formatChipStatus(input: StatusSummaryInput): string {
  if (!input.selectedChip) return "none";
  if (!input.chipInfo) return `${input.selectedChip} / info needed`;
  return [input.chipInfo.name || input.selectedChip, formatChipMemory(input.chipInfo), input.chipInfo.packageName].filter((part): part is string => Boolean(part)).join(" / ");
}

function formatImageStatus(input: StatusSummaryInput): string {
  if (!input.selectedFile) return "none";
  return `${input.selectedFile.name} / ${formatBytes(input.selectedFile.size)} / ${input.selectedFile.sha256Short}`;
}

function formatSafetyStatus(input: StatusSummaryInput): string {
  const dangerous = formatDangerousOptions(input.advanced);
  return dangerous.length > 0 ? `REVIEW ${dangerous.length} override${dangerous.length === 1 ? "" : "s"}` : "OK defaults";
}

function truncateEnd(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return ".".repeat(Math.max(0, width));
  return `${value.slice(0, width - 3)}...`;
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
