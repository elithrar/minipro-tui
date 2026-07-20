import {
  createProgrammer,
  type DeviceDetail,
  type ProgrammerConnection,
  type USBDeviceLike,
  type USBNavigatorLike,
  type XgecuWebUSB,
} from "xgecu-web";
import { usb } from "usb";

import type { ChipInfo, ProgrammerKind, ProgrammerStatus } from "../types";
import type { PinContactResult, ProgrammerBackend, ReadOptions, WriteOptions } from "./backend";

type NodeUsbDeviceHandle = Awaited<ReturnType<typeof usb.getDevices>>[number];

export async function createXgecuBackend(): Promise<ProgrammerBackend> {
  return new DirectXgecuBackend(await createProgrammer({ usb: new NodeUsbNavigator() }));
}

class NodeUsbNavigator implements USBNavigatorLike {
  private readonly devices = new WeakMap<NodeUsbDeviceHandle, NodeUsbDevice>();

  async requestDevice(options: Parameters<USBNavigatorLike["requestDevice"]>[0]): Promise<USBDeviceLike> {
    return this.wrap(await usb.requestDevice(options));
  }

  async getDevices(): Promise<USBDeviceLike[]> {
    return (await usb.getDevices()).map((device) => this.wrap(device));
  }

  private wrap(device: NodeUsbDeviceHandle): NodeUsbDevice {
    const existing = this.devices.get(device);
    if (existing) return existing;

    const wrapped = new NodeUsbDevice(device);
    this.devices.set(device, wrapped);
    return wrapped;
  }
}

class NodeUsbDevice implements USBDeviceLike {
  constructor(private readonly device: NodeUsbDeviceHandle) {}

  get opened(): boolean { return this.device.opened; }
  get vendorId(): number { return this.device.vendorId; }
  get productId(): number { return this.device.productId; }
  get productName(): string | undefined { return this.device.productName ?? undefined; }
  get manufacturerName(): string | undefined { return this.device.manufacturerName ?? undefined; }
  get serialNumber(): string | undefined { return this.device.serialNumber ?? undefined; }
  get configuration(): USBDeviceLike["configuration"] { return this.device.configuration; }

  open(): Promise<void> { return this.device.open(); }
  close(): Promise<void> { return this.device.close(); }
  selectConfiguration(configurationValue: number): Promise<void> {
    return this.device.selectConfiguration(configurationValue);
  }
  claimInterface(interfaceNumber: number): Promise<void> { return this.device.claimInterface(interfaceNumber); }
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void> {
    return this.device.selectAlternateInterface(interfaceNumber, alternateSetting);
  }
  releaseInterface(interfaceNumber: number): Promise<void> { return this.device.releaseInterface(interfaceNumber); }
  transferOut(
    endpointNumber: number,
    data: Parameters<USBDeviceLike["transferOut"]>[1],
  ): ReturnType<USBDeviceLike["transferOut"]> {
    return this.device.transferOut(endpointNumber, data);
  }
  transferIn(endpointNumber: number, length: number): ReturnType<USBDeviceLike["transferIn"]> {
    return this.device.transferIn(endpointNumber, length);
  }
}

class DirectXgecuBackend implements ProgrammerBackend {
  private connection: ProgrammerConnection | undefined;

  constructor(private readonly api: XgecuWebUSB) {}

  listDevices(query: string, programmerKind: ProgrammerKind): ChipInfo[] {
    return this.api.deviceList({ search: query, programmer: programmerKind }).map(toChipInfo);
  }

  resolveDevice(name: string, programmerKind: ProgrammerKind): ChipInfo | undefined {
    const detail = this.api.resolveDevice(name, programmerKind);
    return detail ? toChipInfo(detail) : undefined;
  }

  async getStatus(): Promise<ProgrammerStatus> {
    const first = (await this.api.getProgrammers())[0];
    if (!first) return { connected: false, raw: "No T48/T56 programmer detected." };
    const model = first.productName || "XGecu programmer";
    return {
      connected: true,
      model,
      kind: inferProgrammerKind(model),
      raw: [first.manufacturerName, first.productName, first.serialNumber].filter(Boolean).join(" "),
    };
  }

  async checkPinContacts(options: ReadOptions): Promise<PinContactResult> {
    return this.api.checkPinContacts({
      programmer: await this.ensureConnection(), device: options.chip,
      programmerKind: options.programmerKind === "t48" ? "t48" : "auto", signal: options.signal,
    });
  }

  async readROM(options: ReadOptions): Promise<Uint8Array> {
    return this.api.readROM({
      programmer: await this.ensureConnection(), device: options.chip, programmerKind: options.programmerKind,
      skipIdCheck: options.skipIdCheck, continueOnIdMismatch: options.continueOnIdMismatch,
      signal: options.signal, onProgress: options.onProgress,
    });
  }

  async writeROM(options: WriteOptions): Promise<void> {
    await this.api.writeROM({
      programmer: await this.ensureConnection(), device: options.chip, programmerKind: options.programmerKind,
      data: options.data, erase: options.erase, verify: options.verify, unprotectBefore: options.unprotectBefore,
      skipIdCheck: options.skipIdCheck, continueOnIdMismatch: options.continueOnIdMismatch,
      signal: options.signal, onProgress: options.onProgress,
    });
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    await connection?.close();
  }

  private async ensureConnection(): Promise<ProgrammerConnection> {
    if (!this.connection) this.connection = await this.api.requestProgrammer();
    return this.connection;
  }
}

function toChipInfo(device: DeviceDetail): ChipInfo {
  return {
    name: device.name, aliases: [...device.aliases], memoryBytes: device.codeMemorySize,
    packageName: device.packagePins > 0 ? `DIP${device.packagePins}` : undefined,
    packagePins: device.packagePins, blankValue: device.blankValue, canErase: device.canErase,
    supportsUnprotect: device.supportsUnprotect, supportsProtect: device.supportsProtect,
    supportsPinCheck: device.supportsPinCheck, supportsT48: device.supportsT48, supportsT56: device.supportsT56,
    raw: JSON.stringify(device, null, 2),
  };
}

function inferProgrammerKind(productName: string): ProgrammerKind | undefined {
  const value = productName.toLowerCase();
  if (value.includes("t48")) return "t48";
  if (value.includes("t56")) return "t56";
  return undefined;
}
