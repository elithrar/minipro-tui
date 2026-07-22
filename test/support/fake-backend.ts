import type { ChipInfo, ProgrammerStatus } from "../../src/types";
import type { ProgrammerBackend, ReadOptions, WriteOptions } from "../../src/xgecu/backend";

export const TEST_CHIP: ChipInfo = {
  name: "AT28C64B@DIP28",
  aliases: [],
  memoryBytes: 4,
  packageName: "DIP28",
  packagePins: 28,
  blankValue: 0xff,
  canErase: true,
  supportsUnprotect: false,
  supportsProtect: false,
  supportsPinCheck: true,
  supportsT48: true,
  supportsT56: true,
  raw: "AT28C64B test device",
};

export class FakeBackend implements ProgrammerBackend {
  status: ProgrammerStatus = { connected: false, raw: "" };
  contents = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  readonly calls: string[] = [];
  readonly devices: ChipInfo[] = [TEST_CHIP];
  onRead: ((options: ReadOptions) => Promise<Uint8Array>) | undefined;
  onWrite: ((options: WriteOptions) => Promise<void>) | undefined;

  listDevices(query: string): ChipInfo[] {
    this.calls.push(`list:${query}`);
    const value = query.toLowerCase();
    return this.devices.filter((device) => device.name.toLowerCase().includes(value));
  }

  resolveDevice(name: string): ChipInfo | undefined {
    this.calls.push(`resolve:${name}`);
    return this.devices.find((device) => device.name === name);
  }

  async getStatus(): Promise<ProgrammerStatus> {
    this.calls.push("status");
    return this.status;
  }

  async checkPinContacts(): Promise<{ passed: boolean; checkedPins: number[]; badPins: number[] }> {
    this.calls.push("pins");
    return { passed: true, checkedPins: [1, 28], badPins: [] };
  }

  async readROM(options: ReadOptions): Promise<Uint8Array> {
    this.calls.push("read");
    return this.onRead ? this.onRead(options) : this.contents.slice();
  }

  async writeROM(options: WriteOptions): Promise<void> {
    this.calls.push("write");
    if (this.onWrite) return this.onWrite(options);
    this.contents = options.data.slice();
  }

  async close(): Promise<void> {
    this.calls.push("close");
  }
}
