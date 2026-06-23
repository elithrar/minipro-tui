import type { ChipInfo, FileEntry } from "../types";

export function validateWritePreconditions(input: {
  file?: FileEntry;
  chip?: string;
  chipInfo?: ChipInfo;
  allowSizeMismatch?: boolean;
  confirmed?: boolean;
}): string[] {
  const errors: string[] = [];

  if (!input.file) errors.push("Select a file before starting the write flow.");
  if (!input.chip) errors.push("Select a chip before starting the write flow.");
  if (!input.chipInfo) errors.push("Load chip info before starting the write flow.");
  if (!input.confirmed) errors.push("Confirm erase and write before starting the write flow.");

  if (input.file && input.chipInfo?.memoryBytes !== undefined && input.file.size !== input.chipInfo.memoryBytes && !input.allowSizeMismatch) {
    errors.push(`File size ${input.file.size} B does not match chip memory size ${input.chipInfo.memoryBytes} B.`);
  }

  return errors;
}
