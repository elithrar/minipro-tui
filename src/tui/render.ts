import { parseColor, StyledText, TextAttributes, stripAnsiSequences } from "@opentui/core";

import type { AdvancedOptions, ChipInfo, FileEntry, FileTreeEntry, JobState, ProgrammerKind, ProgrammerStatus } from "../types";
import { formatBytes } from "../files/scan";
import { tuiTheme } from "./theme";

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

export type GuidanceInput = {
  programmerStatus: ProgrammerStatus;
  database: ProgrammerKind;
  selectedChip?: string;
  selectedFile?: FileEntry;
  chipInfo?: ChipInfo;
  job: JobState;
  advanced: AdvancedOptions;
  activeCommandCancellable: boolean;
  notice?: { tone: "info" | "error"; message: string };
  chipSearch?: { query: string; phase: "results" | "details" };
};

const STATUS_LABEL_WIDTH = 8;
const COMMAND_LOG_BG = tuiTheme.elementFocused;
const COMMAND_LOG_FG = parseColor(tuiTheme.primary);
const DANGEROUS_OFF_BG = parseColor(tuiTheme.destructive);
const DANGEROUS_OFF_FG = parseColor(tuiTheme.destructiveText);
const STATUS_LABEL_FG = parseColor(tuiTheme.muted);
const STAGE_ON_FG = parseColor(tuiTheme.success);
const STAGE_OFF_FG = parseColor(tuiTheme.muted);

export function formatStatusLine(input: {
  programmerStatus: ProgrammerStatus;
  database: ProgrammerKind;
  selectedChip?: string;
  selectedFile?: FileEntry;
  job: JobState;
}): string {
  const file = input.selectedFile ? truncateMiddle(input.selectedFile.name, 30) : "no file";
  const chip = input.selectedChip ? truncateMiddle(input.selectedChip, 24) : "no chip";
  const job = input.job.kind === "running" ? input.job.step : input.job.kind;
  return ` ${chip}  //  ${file}  //  ${job.toUpperCase()}`;
}

export function formatGuidanceLine(input: GuidanceInput): string {
  if (input.chipSearch?.phase === "results") return ` Searching ${input.database} chips for "${inlineText(input.chipSearch.query)}"...`;
  if (input.chipSearch?.phase === "details") return " Loading chip details; results are ready to browse.";
  if (input.job.kind === "running") {
    const cancel = input.activeCommandCancellable ? " Press Esc to cancel this step." : "";
    return ` Running: ${inlineText(input.job.step)}.${cancel}`;
  }
  if (input.notice) return ` ${input.notice.tone === "error" ? "Action needed" : "Note"}: ${inlineText(input.notice.message)}`;
  if (input.job.kind === "failed") return ` Failed: ${inlineText(input.job.message)}`;
  if (input.job.kind === "done") return ` Done: ${inlineText(input.job.message)}`;
  if (!input.selectedFile) return " Next: choose an image in Files. Press F to filter the current folder.";
  if (!input.selectedChip) return " Next: search for a chip with /, then press Enter to select it.";
  if (!input.chipInfo) return " Next: wait for chip details before starting a hardware action.";

  if (!/\.(hex|srec)$/i.test(input.selectedFile.name) && input.chipInfo.memoryBytes !== undefined && input.selectedFile.size !== input.chipInfo.memoryBytes && !input.advanced.allowSizeMismatch) {
    return " Blocked: image and chip sizes differ. Choose another image or chip.";
  }

  const overrideCount = formatDangerousOptions(input.advanced).length;
  if (overrideCount > 0) return ` Review: ${overrideCount} safety override${overrideCount === 1 ? " is" : "s are"} active. Press A before continuing.`;
  if (!input.programmerStatus.connected) return " Ready to review. Connect a programmer before starting a hardware action.";
  return " Ready: press W to review the safe write flow.";
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
  const isDefault = chip === "AT28C64B" || chip.startsWith("AT28C64B@");
  const labelParts = [isDefault ? "default" : undefined, metadata].filter((part): part is string => Boolean(part));
  return {
    name: labelParts.length > 0 ? `${chip} (${labelParts.join(", ")})` : chip,
    description: isDefault ? "default" : "",
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

function inlineText(value: string): string {
  return stripAnsiSequences(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export function formatChipInfo(info?: ChipInfo): string {
  if (!info) return "Default chip query is AT28C64B. Select a chip search result to load chip info.";

  return [
    info.name || "Unknown",
    `Aliases: ${info.aliases && info.aliases.length > 0 ? info.aliases.join(", ") : "none"}`,
    `Memory: ${info.memoryBytes === undefined ? "unknown" : `${info.memoryBytes} B`}`,
    `Package: ${info.packageName ?? "unknown"}`,
    `Blank value: ${info.blankValue === undefined ? "unknown" : `0x${info.blankValue.toString(16).padStart(2, "0")}`}`,
    `Electrical erase: ${info.canErase ? "supported" : "external erase required"}`,
    `Pin check: ${info.supportsPinCheck ? "supported" : "unavailable"}`,
    `Programmers: ${[info.supportsT48 ? "T48" : undefined, info.supportsT56 ? "T56" : undefined].filter(Boolean).join(", ")}`,
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

  const parts = [formatPackageName(info.packageName), info.canErase ? "erasable" : "external erase"].filter((part): part is string => Boolean(part));
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
  if (input.chipInfo.memoryBytes === undefined) return "BLOCKED chip size unknown";
  if (/\.(hex|srec)$/i.test(input.selectedFile.name)) return "CHECK structured image normalized on confirm";
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
  const chunks: StyledText["chunks"] = [{ __isChunk: true, text: prefix, fg: STATUS_LABEL_FG }];

  if (row.stage === "on") {
    chunks.push({ __isChunk: true, text: value, fg: STAGE_ON_FG, attributes: TextAttributes.BOLD });
  } else if (row.stage === "danger-off") {
    chunks.push({ __isChunk: true, text: value, fg: DANGEROUS_OFF_FG, bg: DANGEROUS_OFF_BG, attributes: TextAttributes.BOLD });
  } else if (row.stage === "off") {
    chunks.push({ __isChunk: true, text: value, fg: STAGE_OFF_FG });
  } else {
    chunks.push({ __isChunk: true, text: value });
  }

  if (suffix) chunks.push({ __isChunk: true, text: suffix });
  return chunks;
}

type StatusRow = {
  label: string;
  value: string;
  stage?: "on" | "off" | "danger-off";
};

function statusRows(input: StatusSummaryInput): StatusRow[] {
  const programmer = input.programmerStatus.connected ? (input.programmerStatus.model ?? "connected") : "disconnected";
  return [
    { label: "Fit", value: formatFitValue(input) },
    stageRow("Backup", Boolean(input.advanced.backupBeforeWrite), false),
    stageRow("Erase", !input.advanced.skipErase, false),
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
  return { label, value: stageState(enabled), stage: enabled ? "on" : dangerousWhenOff ? "danger-off" : "off" };
}

function stageState(enabled: boolean): string {
  return enabled ? "● ON" : "○ OFF";
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
    options.unprotectBefore ? "write protection disabled" : undefined,
    options.allowSizeMismatch ? "size mismatch allowed" : undefined,
    options.disableReadbackCompare ? "readback compare off" : undefined,
    options.skipVerify ? "verify skipped" : undefined,
    options.ignoreIdMismatch ? "ID mismatch ignored" : undefined,
    options.skipIdRead ? "ID read skipped" : undefined,
  ].filter((item): item is string => item !== undefined);
}
