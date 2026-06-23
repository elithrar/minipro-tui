import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { clearHashCache, sha256File, shortSha } from "../src/files/hash";
import { scanFiles } from "../src/files/scan";

test("file scanner excludes directories and shows programming files by default", async () => {
  const dir = join(import.meta.dir, ".tmp-files");
  await mkdir(join(dir, "nested"), { recursive: true });
  await writeFile(join(dir, "image.bin"), new Uint8Array([1, 2, 3]));
  await writeFile(join(dir, "notes.txt"), "hello");
  const files = await scanFiles(dir);
  expect(files.map((file) => file.name)).toEqual(["image.bin"]);
});

test("file scanner can include all files", async () => {
  const dir = join(import.meta.dir, ".tmp-files-all");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "image.bin"), new Uint8Array([1]));
  await writeFile(join(dir, "notes.txt"), "hello");
  const files = await scanFiles(dir, true);
  expect(files.map((file) => file.name)).toEqual(["image.bin", "notes.txt"]);
});

test("hash cache invalidates when file size or mtime changes", async () => {
  clearHashCache();
  const dir = join(import.meta.dir, ".tmp-hash");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "image.bin");
  await writeFile(path, new Uint8Array([1]));
  const first = await sha256File(path, 1, 1);
  await writeFile(path, new Uint8Array([2, 3]));
  const second = await sha256File(path, 2, 2);
  expect(second).not.toEqual(first);
});

test("short SHA output is stable", () => {
  expect(shortSha("1234567890abcdef", 8)).toBe("12345678");
});
