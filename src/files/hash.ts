import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

type CacheEntry = {
  size: number;
  mtimeMs: number;
  sha256: string;
};

const hashCache = new Map<string, CacheEntry>();

export async function sha256File(path: string, size: number, mtimeMs: number): Promise<string> {
  const cached = hashCache.get(path);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    return cached.sha256;
  }

  const data = await readFile(path);
  const after = await stat(path);
  if (after.size !== size || after.mtimeMs !== mtimeMs) {
    hashCache.delete(path);
    throw new Error("File changed while hashing.");
  }

  const sha256 = sha256Bytes(data);
  hashCache.set(path, { size, mtimeMs, sha256 });
  return sha256;
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function shortSha(sha256: string, length = 12): string {
  return sha256.slice(0, length);
}

export function clearHashCache(): void {
  hashCache.clear();
}
