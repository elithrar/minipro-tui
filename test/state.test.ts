import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { loadState, saveState, type PersistedState } from "../src/state";

test("persists and restores preferences and recents", async () => {
  const dir = join(import.meta.dir, ".tmp-state");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "state.json");
  const state: PersistedState = {
    version: 1,
    database: "t56",
    showAllFiles: true,
    advanced: { backupBeforeWrite: true, skipVerify: true },
    recentFilePaths: ["/tmp/image.bin"],
    recentDirectories: ["/tmp"],
    recentChips: ["AT28C64B"],
    recentDatabases: ["t56", "t48"],
  };

  await saveState(state, path);
  expect(await loadState(path)).toEqual({
    ...state,
    advanced: {
      backupBeforeWrite: true,
    },
  });
});

test("rejects malformed or unsupported persisted state", async () => {
  const dir = join(import.meta.dir, ".tmp-state");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "invalid.json");
  await writeFile(path, JSON.stringify({ version: 2, database: "unknown" }));
  expect(await loadState(path)).toBeUndefined();
});
