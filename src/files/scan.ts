import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { FileEntry } from "../types";
import { sha256File, shortSha } from "./hash";

const LIKELY_BINARY_EXTENSIONS = new Set([".bin", ".rom", ".hex", ".srec", ".eep"]);

export async function scanFiles(dir = process.cwd(), showAll = false): Promise<FileEntry[]> {
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: FileEntry[] = [];

  for (const dirent of names) {
    if (!dirent.isFile()) continue;
    const path = join(dir, dirent.name);
    if (!showAll && !isLikelyProgrammingFile(dirent.name)) continue;

    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) continue;
      const sha256 = await sha256File(path, fileStat.size, fileStat.mtimeMs);
      entries.push({
        name: dirent.name,
        path,
        size: fileStat.size,
        modifiedAt: fileStat.mtime,
        sha256Short: shortSha(sha256),
      });
    } catch {
      continue;
    }
  }

  return entries.sort(compareFileEntries);
}

export function isLikelyProgrammingFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return LIKELY_BINARY_EXTENSIONS.has(extension);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function compareFileEntries(a: FileEntry, b: FileEntry): number {
  const aLikely = isLikelyProgrammingFile(a.name);
  const bLikely = isLikelyProgrammingFile(b.name);
  if (aLikely !== bLikely) return aLikely ? -1 : 1;
  const modified = b.modifiedAt.getTime() - a.modifiedAt.getTime();
  if (modified !== 0) return modified;
  return a.name.localeCompare(b.name);
}
