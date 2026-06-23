import type { AdvancedOptions } from "../types";

export const DEFAULT_ADVANCED_OPTIONS: AdvancedOptions = {
  disableReadbackCompare: false,
};

export function dangerousOptionWarnings(options: AdvancedOptions): string[] {
  const warnings: string[] = [];

  if (options.skipErase) warnings.push("Skip erase is enabled. Old chip contents may remain before programming.");
  if (options.skipVerify) warnings.push("Skip verify is enabled. The app will not confirm that bytes on the chip match the selected file after writing.");
  if (options.allowSizeMismatch) warnings.push("Size mismatch override is enabled. The selected file may not match the chip memory size.");
  if (options.ignoreIdMismatch) warnings.push("Ignore ID mismatch is enabled. The selected chip may not be the chip in the socket.");
  if (options.skipIdRead) warnings.push("Skip ID read is enabled for read mode. Chip identity checks may be bypassed.");
  if (options.disableReadbackCompare) warnings.push("Readback compare is disabled. The app will not compare the programmed bytes after writing.");

  return warnings;
}

export function hasDangerousOptions(options: AdvancedOptions): boolean {
  return dangerousOptionWarnings(options).length > 0;
}
