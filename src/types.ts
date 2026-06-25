export type ProgrammerKind = "tl866a" | "tl866ii" | "t48" | "t56";

export type ProgrammerStatus = {
  connected: boolean;
  model?: string;
  kind?: ProgrammerKind;
  raw: string;
};

export type ProgrammerDatabase = {
  kind: ProgrammerKind;
  label: string;
  raw: string;
};

export type FileEntry = {
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
  sha256Short: string;
};

export type ChipInfo = {
  name: string;
  availableOn?: string;
  memoryBytes?: number;
  packageName?: string;
  vpp?: string;
  vdd?: string;
  vcc?: string;
  pulseDelay?: string;
  icsp?: string;
  protocol?: string;
  readBufferSize?: number;
  writeBufferSize?: number;
  raw: string;
};

export type MiniproResult = {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type JobState =
  | { kind: "idle" }
  | { kind: "running"; step: string }
  | { kind: "failed"; step: string; message: string }
  | { kind: "done"; message: string };

export type AdvancedOptions = {
  memoryType?: "code" | "data" | "config" | "user" | "calibration";
  fileFormat?: "ihex" | "srec";
  vpp?: string;
  vdd?: string;
  vcc?: string;
  pulseDelay?: string;
  spiSpeed?: string;
  unprotect?: boolean;
  protect?: boolean;
  icspVcc?: boolean;
  icspNoVcc?: boolean;
  skipErase?: boolean;
  skipVerify?: boolean;
  allowSizeMismatch?: boolean;
  ignoreIdMismatch?: boolean;
  skipIdRead?: boolean;
  disableReadbackCompare?: boolean;
};
