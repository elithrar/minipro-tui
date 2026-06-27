import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { clearHashCache, sha256File, shortSha } from "../src/files/hash";
import { scanFiles, scanFileTree } from "../src/files/scan";

test("file scanner excludes directories and shows programming files by default", async () => {
  const dir = join(import.meta.dir, ".tmp-files");
  await mkdir(join(dir, "nested"), { recursive: true });
  await writeFile(join(dir, "image.bin"), new Uint8Array([1, 2, 3]));
  await writeFile(join(dir, "notes.txt"), "hello");
  const files = await scanFiles(dir);
  expect(files.map((file) => file.name)).toEqual(["image.bin"]);
});

test("file tree scanner includes directories and filters files by default", async () => {
  const dir = join(import.meta.dir, ".tmp-file-tree");
  await mkdir(join(dir, "nested"), { recursive: true });
  await writeFile(join(dir, "image.bin"), new Uint8Array([1, 2, 3]));
  await writeFile(join(dir, "notes.txt"), "hello");

  const entries = await scanFileTree(dir);

  expect(entries.map((entry) => entry.name)).toContain("nested");
  expect(entries.map((entry) => entry.name)).toContain("image.bin");
  expect(entries.map((entry) => entry.name)).not.toContain("notes.txt");
});

test("file scanner can include all files", async () => {
  const dir = join(import.meta.dir, ".tmp-files-all");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "image.bin"), new Uint8Array([1]));
  await writeFile(join(dir, "notes.txt"), "hello");
  const files = await scanFiles(dir, true);
  expect(files.map((file) => file.name)).toEqual(["image.bin", "notes.txt"]);
});

test("file scanner orders files by newest modified time first", async () => {
  const dir = join(import.meta.dir, ".tmp-files-sort");
  await mkdir(dir, { recursive: true });
  const older = join(dir, "older.bin");
  const newer = join(dir, "newer.bin");
  await writeFile(older, new Uint8Array([1]));
  await writeFile(newer, new Uint8Array([2]));
  await utimes(older, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  await utimes(newer, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));

  const files = await scanFiles(dir);

  expect(files.map((file) => file.name)).toEqual(["newer.bin", "older.bin"]);
});

test("hash cache invalidates when file size or mtime changes", async () => {
  clearHashCache();
  const dir = join(import.meta.dir, ".tmp-hash");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "image.bin");
  await writeFile(path, new Uint8Array([1]));
  const firstStat = await stat(path);
  const first = await sha256File(path, firstStat.size, firstStat.mtimeMs);
  await writeFile(path, new Uint8Array([2, 3]));
  const secondStat = await stat(path);
  const second = await sha256File(path, secondStat.size, secondStat.mtimeMs);
  expect(second).not.toEqual(first);
});

test("hashing rejects stale file metadata", async () => {
  clearHashCache();
  const dir = join(import.meta.dir, ".tmp-hash");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "stale.bin");
  await writeFile(path, new Uint8Array([1]));

  await expect(sha256File(path, 1, 1)).rejects.toThrow("File changed while hashing.");
});

test("short SHA output is stable", () => {
  expect(shortSha("1234567890abcdef", 8)).toBe("12345678");
});
