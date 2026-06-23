import type { ChipInfo, FileEntry, JobState, ProgrammerKind, ProgrammerStatus } from "../types";
import { formatBytes } from "../files/scan";

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
