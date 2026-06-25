import type { ChipInfo, ProgrammerDatabase, ProgrammerKind, ProgrammerStatus } from "../types";

const PROGRAMMER_KINDS: ProgrammerKind[] = ["tl866a", "tl866ii", "t48", "t56"];

export function parseProgrammerDatabases(raw: string): ProgrammerDatabase[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^(\w+):\s*(.+)$/.exec(line);
      if (!match) return [];
      const kind = match[1]?.toLowerCase();
      if (!isProgrammerKind(kind)) return [];
      return [{ kind, label: match[2] ?? "", raw: line }];
    });
}

export function parseProgrammerStatus(raw: string): ProgrammerStatus {
  const trimmed = raw.trim();
  if (!trimmed || /\[no programmer found\]/i.test(trimmed) || /spawn .*enoent|no such file or directory|command not found/i.test(trimmed)) {
    return { connected: false, raw };
  }

  const firstLine = trimmed.split(/\r?\n/).find(Boolean);
  return {
    connected: true,
    model: firstLine,
    kind: detectProgrammerKind(trimmed),
    raw,
  };
}

export function parseChipSearch(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseChipInfo(raw: string): ChipInfo {
  const info: ChipInfo = { name: "", raw };

  for (const line of raw.split(/\r?\n/)) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (!key || !value) continue;

    switch (key.trim().toLowerCase()) {
      case "name":
        info.name = value;
        break;
      case "available on":
        info.availableOn = value;
        break;
      case "memory":
        info.memoryBytes = parseBytes(value);
        break;
      case "package":
        info.packageName = value;
        break;
      case "vpp programming voltage":
        info.vpp = value;
        break;
      case "vdd write voltage":
        info.vdd = value;
        break;
      case "vcc verify voltage":
        info.vcc = value;
        break;
      case "pulse delay":
        info.pulseDelay = value;
        break;
      case "icsp":
        info.icsp = value;
        break;
      case "protocol":
        info.protocol = value;
        break;
      case "read buffer size":
        info.readBufferSize = parseBytes(value);
        break;
      case "write buffer size":
        info.writeBufferSize = parseBytes(value);
        break;
    }
  }

  return info;
}

export function detectProgrammerKind(raw: string): ProgrammerKind | undefined {
  const lower = raw.toLowerCase();
  if (lower.includes("t56")) return "t56";
  if (lower.includes("t48")) return "t48";
  if (lower.includes("tl866ii")) return "tl866ii";
  if (lower.includes("tl866")) return "tl866a";
  return undefined;
}

function parseBytes(value: string): number | undefined {
  const match = /([\d,]+)\s*bytes?/i.exec(value);
  if (!match) return undefined;
  return Number.parseInt(match[1]?.replaceAll(",", "") ?? "", 10);
}

function isProgrammerKind(value: string | undefined): value is ProgrammerKind {
  return PROGRAMMER_KINDS.includes(value as ProgrammerKind);
}
