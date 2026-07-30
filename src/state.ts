import { mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AdvancedOptions, ProgrammerKind } from "./types";

export type PersistedState = {
  version: 1;
  database: ProgrammerKind;
  showAllFiles: boolean;
  advanced: AdvancedOptions;
  recentFilePaths: string[];
  recentDirectories: string[];
  recentChips: string[];
  recentDatabases: ProgrammerKind[];
};

export function stateFilePath(): string {
  if (process.env.CHIPDESK_STATE) return process.env.CHIPDESK_STATE;
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "chipdesk", "state.json");
}

export async function loadState(path = stateFilePath()): Promise<PersistedState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return parseState(value);
  } catch {
    return undefined;
  }
}

export async function saveState(state: PersistedState, path = stateFilePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempDirectory = await mkdtemp(join(dirname(path), ".state-"));
  const tempPath = join(tempDirectory, "state.json");
  try {
    const file = await open(tempPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tempPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM" || code === "EACCES";
}

function parseState(value: unknown): PersistedState | undefined {
  if (!isRecord(value) || value.version !== 1 || !isProgrammerKind(value.database)) return undefined;
  return {
    version: 1,
    database: value.database,
    showAllFiles: value.showAllFiles === true,
    advanced: parseAdvanced(value.advanced),
    recentFilePaths: stringArray(value.recentFilePaths),
    recentDirectories: stringArray(value.recentDirectories),
    recentChips: stringArray(value.recentChips),
    recentDatabases: stringArray(value.recentDatabases).filter(isProgrammerKind),
  };
}

function parseAdvanced(value: unknown): AdvancedOptions {
  if (!isRecord(value)) return {};
  return {
    backupBeforeWrite: value.backupBeforeWrite === true,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 8) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProgrammerKind(value: unknown): value is ProgrammerKind {
  return value === "t48" || value === "t56" || value === "t76";
}
