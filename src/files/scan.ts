import { readdir, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import type { FileEntry, FileTreeEntry } from "../types";
import { sha256File, shortSha } from "./hash";

const LIKELY_BINARY_EXTENSIONS = new Set([".bin", ".rom", ".hex", ".srec", ".eep"]);

export async function scanFiles(dir = process.cwd(), showAll = false): Promise<FileEntry[]> {
  const entries = await scanFileTree(dir, showAll);
  return entries.filter(isFileEntry);
}

export async function scanFileTree(dir = process.cwd(), showAll = false): Promise<FileTreeEntry[]> {
  let names;
  const root = resolve(dir);
  try {
    names = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const entries: FileTreeEntry[] = [];
  const parent = dirname(root);
  if (parent !== root && root !== parse(root).root) {
    entries.push({ kind: "directory", name: "..", path: parent, modifiedAt: new Date(0) });
  }

  for (const dirent of names) {
    const path = join(root, dirent.name);

    if (dirent.isDirectory()) {
      try {
        const directoryStat = await stat(path);
        if (!directoryStat.isDirectory()) continue;
        entries.push({ kind: "directory", name: dirent.name, path, modifiedAt: directoryStat.mtime });
      } catch {
        continue;
      }
      continue;
    }

    if (!dirent.isFile() || (!showAll && !isLikelyProgrammingFile(dirent.name))) continue;

    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) continue;
      const sha256 = await sha256File(path, fileStat.size, fileStat.mtimeMs);
      entries.push({
        kind: "file",
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

  return entries.sort(compareFileTreeEntries);
}

export function isFileEntry(entry: FileTreeEntry): entry is FileEntry {
  return entry.kind !== "directory";
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

function compareFileTreeEntries(a: FileTreeEntry, b: FileTreeEntry): number {
  if (a.kind === "directory" || b.kind === "directory") {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    if (a.name === "..") return -1;
    if (b.name === "..") return 1;
    return a.name.localeCompare(b.name);
  }

  return compareFileEntries(a, b);
}
