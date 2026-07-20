export type ProgrammerKind = "t48" | "t56";

export type ProgrammerStatus = {
  connected: boolean;
  model?: string;
  kind?: ProgrammerKind;
  raw: string;
};

export type FileEntry = {
  kind?: "file";
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
  sha256Short: string;
};

export type DirectoryEntry = {
  kind: "directory";
  name: string;
  path: string;
  modifiedAt: Date;
};

export type FileTreeEntry = FileEntry | DirectoryEntry;

export type ChipInfo = {
  name: string;
  aliases?: string[];
  memoryBytes?: number;
  packageName?: string;
  packagePins?: number;
  blankValue?: number;
  canErase?: boolean;
  supportsUnprotect?: boolean;
  supportsProtect?: boolean;
  supportsPinCheck?: boolean;
  supportsT48?: boolean;
  supportsT56?: boolean;
  raw: string;
};

export type JobState =
  | { kind: "idle" }
  | { kind: "running"; step: string }
  | { kind: "failed"; step: string; message: string }
  | { kind: "done"; message: string };

export type AdvancedOptions = {
  unprotectBefore?: boolean;
  skipErase?: boolean;
  skipVerify?: boolean;
  allowSizeMismatch?: boolean;
  ignoreIdMismatch?: boolean;
  skipIdRead?: boolean;
  disableReadbackCompare?: boolean;
  backupBeforeWrite?: boolean;
};
