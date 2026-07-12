import { extname } from "node:path";

const MAX_NORMALIZED_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_STRUCTURED_SOURCE_BYTES = 4 * 1024 * 1024;

export function normalizeImageBytes(path: string, bytes: Uint8Array): Uint8Array {
  const extension = extname(path).toLowerCase();
  if ((extension === ".hex" || extension === ".srec") && bytes.byteLength > MAX_STRUCTURED_SOURCE_BYTES) {
    throw new Error(`Structured image source exceeds ${MAX_STRUCTURED_SOURCE_BYTES} bytes.`);
  }
  if (extension === ".hex") return parseIntelHex(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (extension === ".srec") return parseSRecord(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return bytes;
}

function parseIntelHex(content: string): Uint8Array {
  const image = new Map<number, number>();
  let baseAddress = 0;
  let sawEnd = false;

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    if (sawEnd) throw new Error(`Intel HEX contains data after the end-of-file record on line ${index + 1}.`);
    if (!line.startsWith(":")) throw new Error(`Invalid Intel HEX record on line ${index + 1}.`);
    const record = hexBytes(line.slice(1), index + 1);
    const length = record[0];
    if (length === undefined || record.length !== length + 5 || checksum(record) !== 0) throw new Error(`Invalid Intel HEX record on line ${index + 1}.`);
    const address = ((record[1] ?? 0) << 8) | (record[2] ?? 0);
    const type = record[3];
    const data = record.slice(4, 4 + length);

    if (type === 0x00) {
      for (let offset = 0; offset < data.length; offset++) setImageByte(image, baseAddress + address + offset, data[offset]!);
    } else if (type === 0x01) {
      if (address !== 0 || data.length !== 0) throw new Error(`Invalid Intel HEX end-of-file record on line ${index + 1}.`);
      sawEnd = true;
    } else if (type === 0x02 && data.length === 2) {
      baseAddress = (((data[0] ?? 0) << 8) | (data[1] ?? 0)) << 4;
    } else if (type === 0x04 && data.length === 2) {
      baseAddress = ((((data[0] ?? 0) << 8) | (data[1] ?? 0)) * 0x10000);
    } else if (type !== 0x03 && type !== 0x05) {
      throw new Error(`Unsupported Intel HEX record type on line ${index + 1}.`);
    }
  }

  if (!sawEnd) throw new Error("Intel HEX image has no end-of-file record.");
  return materializeImage(image);
}

function parseSRecord(content: string): Uint8Array {
  const image = new Map<number, number>();
  let sawData = false;
  let sawEnd = false;
  let dataType: "1" | "2" | "3" | undefined;
  let dataRecordCount = 0;
  let declaredDataRecordCount: number | undefined;

  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    if (sawEnd) throw new Error(`S-record contains data after the termination record on line ${index + 1}.`);
    if (!/^S[0-9]/.test(line)) throw new Error(`Invalid S-record on line ${index + 1}.`);
    const type = line[1]!;
    const record = hexBytes(line.slice(2), index + 1);
    const count = record[0];
    if (count === undefined || record.length !== count + 1 || checksum(record) !== 0xff) throw new Error(`Invalid S-record on line ${index + 1}.`);
    const recordDataType = type === "1" || type === "2" || type === "3" ? type : undefined;
    const addressBytes = recordDataType === "1" ? 2 : recordDataType === "2" ? 3 : recordDataType === "3" ? 4 : 0;
    if (addressBytes === 0) {
      if (type === "7" || type === "8" || type === "9") {
        const terminationAddressBytes = type === "7" ? 4 : type === "8" ? 3 : 2;
        if (record.length !== terminationAddressBytes + 2) throw new Error(`Invalid S-record termination record on line ${index + 1}.`);
        const expected = dataType === "1" ? "9" : dataType === "2" ? "8" : dataType === "3" ? "7" : undefined;
        if (expected && type !== expected) throw new Error(`S-record termination type does not match its data records on line ${index + 1}.`);
        sawEnd = true;
      } else if (type === "4") {
        throw new Error(`Unsupported S-record type on line ${index + 1}.`);
      } else if (type === "5" || type === "6") {
        const countAddressBytes = type === "5" ? 2 : 3;
        if (record.length !== countAddressBytes + 2) throw new Error(`Invalid S-record count record on line ${index + 1}.`);
        let count = 0;
        for (let offset = 0; offset < countAddressBytes; offset++) count = count * 256 + (record[1 + offset] ?? 0);
        declaredDataRecordCount = count;
      } else if (type !== "0") {
        throw new Error(`Unsupported S-record type on line ${index + 1}.`);
      }
      continue;
    }
    if (dataType && dataType !== recordDataType) throw new Error(`S-record mixes data address widths on line ${index + 1}.`);
    dataType = recordDataType;
    sawData = true;
    dataRecordCount++;
    let address = 0;
    for (let offset = 0; offset < addressBytes; offset++) address = address * 256 + (record[1 + offset] ?? 0);
    const data = record.slice(1 + addressBytes, -1);
    for (let offset = 0; offset < data.length; offset++) setImageByte(image, address + offset, data[offset]!);
  }

  if (!sawData) throw new Error("S-record image has no data records.");
  if (!sawEnd) throw new Error("S-record image has no termination record.");
  if (declaredDataRecordCount !== undefined && declaredDataRecordCount !== dataRecordCount) throw new Error("S-record count does not match its data records.");
  return materializeImage(image);
}

function hexBytes(value: string, line: number): number[] {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) throw new Error(`Invalid hexadecimal data on line ${line}.`);
  return value.match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
}

function checksum(bytes: number[]): number {
  return bytes.reduce((sum, value) => (sum + value) & 0xff, 0);
}

function setImageByte(image: Map<number, number>, address: number, value: number): void {
  const existing = image.get(address);
  if (existing !== undefined && existing !== value) throw new Error(`Image contains conflicting data at address 0x${address.toString(16)}.`);
  image.set(address, value);
}

function materializeImage(image: Map<number, number>): Uint8Array {
  if (image.size === 0) throw new Error("Image contains no programmable data.");
  let end = 0;
  for (const address of image.keys()) {
    end = Math.max(end, address);
  }
  const length = end + 1;
  if (length > MAX_NORMALIZED_BYTES) throw new Error(`Normalized image exceeds ${MAX_NORMALIZED_BYTES} bytes.`);
  const bytes = new Uint8Array(length).fill(0xff);
  for (const [address, value] of image) bytes[address] = value;
  return bytes;
}
