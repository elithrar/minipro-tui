import type { ChipInfo, ProgrammerKind, ProgrammerStatus } from "../types";

export type BackendProgress = {
  phase: "connecting" | "identifying" | "erasing" | "writing" | "reading" | "verifying" | "cleanup" | "done" | "failed";
  offset: number;
  total: number;
};

export type PinContactResult = {
  passed: boolean;
  checkedPins: number[];
  badPins: number[];
};

export type ReadOptions = {
  chip: string;
  programmerKind: ProgrammerKind;
  skipIdCheck?: boolean;
  continueOnIdMismatch?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: BackendProgress) => void;
};

export type WriteOptions = ReadOptions & {
  data: Uint8Array;
  erase: boolean;
  verify: boolean;
  unprotectBefore: boolean;
};

export interface ProgrammerBackend {
  listDevices(query: string, programmerKind: ProgrammerKind): ChipInfo[];
  resolveDevice(name: string, programmerKind: ProgrammerKind): ChipInfo | undefined;
  getStatus(): Promise<ProgrammerStatus>;
  checkPinContacts(options: ReadOptions): Promise<PinContactResult>;
  readROM(options: ReadOptions): Promise<Uint8Array>;
  writeROM(options: WriteOptions): Promise<void>;
  close(): Promise<void>;
}
