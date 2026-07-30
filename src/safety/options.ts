import type { AdvancedOptions, ChipInfo, ProgrammerKind } from "../types";

export const DEFAULT_ADVANCED_OPTIONS: AdvancedOptions = {
  disableReadbackCompare: false,
  backupBeforeWrite: false,
};

export function dangerousOptionWarnings(options: AdvancedOptions): string[] {
  const warnings: string[] = [];

  if (options.unprotectBefore) warnings.push("Write protection will be disabled before programming and will not be restored automatically.");
  if (options.skipVerify) warnings.push(`Backend verify is disabled.${options.disableReadbackCompare ? " No post-write byte comparison will run." : " Independent readback byte comparison remains enabled."}`);
  if (options.allowSizeMismatch) warnings.push("Size mismatch override is enabled. The selected file may not match the chip memory size.");
  if (options.ignoreIdMismatch) warnings.push("Ignore ID mismatch is enabled. The selected chip may not be the chip in the socket.");
  if (options.skipIdRead) warnings.push("Skip ID read is enabled for read mode. Chip identity checks may be bypassed.");
  if (options.disableReadbackCompare) warnings.push("Readback compare is disabled. The app will not compare the programmed bytes after writing.");

  return warnings;
}

export function hasDangerousOptions(options: AdvancedOptions): boolean {
  return dangerousOptionWarnings(options).length > 0;
}

export function programmerWriteWarnings(programmerKind: ProgrammerKind, chip: ChipInfo): string[] {
  if (programmerKind !== "t76" || !chip.supportsUnprotect) return [];
  return [
    "T76 will automatically disable this target's software write protection before erase and will leave it disabled after writing.",
  ];
}
