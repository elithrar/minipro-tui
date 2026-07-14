import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { InputRenderable, SelectRenderable } from "@opentui/core";

import { MiniproTuiApp } from "../src/app";
import type { MiniproResult } from "../src/types";

test("switches from the desktop workbench to native compact tabs on resize", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  let exitCode: number | undefined;
  const app = new MiniproTuiApp({
    renderer: setup.renderer,
    persistence: false,
    exit: (code) => { exitCode = code; },
    commandRunner: async (args) => {
      if (args[0] === "-Q") return result(args, await Bun.file("fixtures/minipro-q.txt").text());
      if (args[0] === "-k") return result(args, await Bun.file("fixtures/minipro-k-none.txt").text());
      if (args.includes("-L")) return result(args, await Bun.file("fixtures/minipro-l-at28c64b.txt").text());
      if (args.includes("-d")) return result(args, "", await Bun.file("fixtures/minipro-d-at28c64b.txt").text());
      return result(args);
    },
  });

  await app.start();
  await setup.flush();
  const desktop = setup.captureCharFrame();
  expect(desktop).toContain("Chip Search");
  expect(desktop).toContain("Actions / Log");
  expect(desktop).toContain("Safety");
  expect(desktop).toContain("╭");
  expect(desktop).toContain("┏");
  expect(desktop).toContain("[Tab] focus");
  expect(desktop).toContain("[Enter] open");
  expect(desktop).toContain("[E] EPROMs");

  setup.mockInput.pressKey("f");
  await setup.flush();
  const fileQuery = setup.renderer.root.findDescendantById("file-query") as InputRenderable;
  expect(fileQuery.focused).toBe(true);
  expect(fileQuery.value).toBe("");
  setup.mockInput.pressKey("q");
  await setup.flush();
  expect(fileQuery.value).toBe("q");
  expect(exitCode).toBeUndefined();

  const chips = setup.renderer.root.findDescendantById("chips") as SelectRenderable;
  chips.focus();
  setup.mockInput.pressKey("i");
  await setup.flush();

  setup.resize(70, 24);
  await setup.flush();
  setup.mockInput.pressEnter();
  await setup.flush();
  const compact = setup.captureCharFrame();
  expect(compact).toContain("Files");
  expect(compact).toContain("Chips");
  expect(compact).toContain("Status");
  expect(compact).toContain("Log");
  expect(compact).not.toContain("Actions / Log");
  expect(chips.focused).toBe(true);

  setup.resize(120, 32);
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Actions / Log");
  setup.renderer.destroy();
});

test("compact chip shortcut moves focus before a slow search completes", async () => {
  const setup = await createTestRenderer({ width: 70, height: 24 });
  let delaySearch = false;
  let releaseSearch: (() => void) | undefined;
  const app = new MiniproTuiApp({
    renderer: setup.renderer,
    persistence: false,
    commandRunner: async (args) => {
      if (args[0] === "-Q") return result(args, await Bun.file("fixtures/minipro-q.txt").text());
      if (args[0] === "-k") return result(args, await Bun.file("fixtures/minipro-k-none.txt").text());
      if (args.includes("-L")) {
        if (delaySearch) await new Promise<void>((resolve) => { releaseSearch = resolve; });
        return result(args, await Bun.file("fixtures/minipro-l-at28c64b.txt").text());
      }
      if (args.includes("-d")) return result(args, "", await Bun.file("fixtures/minipro-d-at28c64b.txt").text());
      return result(args);
    },
  });
  await app.start();
  setup.mockInput.pressKey("f");
  await setup.flush();
  delaySearch = true;
  const files = setup.renderer.root.findDescendantById("files") as SelectRenderable;
  files.focus();
  setup.mockInput.pressKey("e");
  await setup.flush();

  const chipQuery = setup.renderer.root.findDescendantById("chip-query") as InputRenderable;
  expect(chipQuery.focused).toBe(true);
  expect(setup.captureCharFrame()).toContain("Chip Search");
  releaseSearch?.();
  await Bun.sleep(0);
  setup.renderer.destroy();
});

test("quit aborts and joins an in-flight database search", async () => {
  const setup = await createTestRenderer({ width: 100, height: 28 });
  let delaySearch = false;
  let searchAborted = false;
  let exitCode: number | undefined;
  const app = new MiniproTuiApp({
    renderer: setup.renderer,
    persistence: false,
    exit: (code) => { exitCode = code; },
    commandRunner: async (args, options) => {
      if (args[0] === "-Q") return result(args, await Bun.file("fixtures/minipro-q.txt").text());
      if (args[0] === "-k") return result(args, await Bun.file("fixtures/minipro-k-none.txt").text());
      if (args.includes("-L") && delaySearch) {
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => {
          searchAborted = true;
          resolve();
        }, { once: true }));
        return { ...result(args), exitCode: null, aborted: true };
      }
      if (args.includes("-L")) return result(args, await Bun.file("fixtures/minipro-l-at28c64b.txt").text());
      if (args.includes("-d")) return result(args, "", await Bun.file("fixtures/minipro-d-at28c64b.txt").text());
      return result(args);
    },
  });
  await app.start();
  delaySearch = true;
  const files = setup.renderer.root.findDescendantById("files") as SelectRenderable;
  files.focus();
  setup.mockInput.pressKey("e");
  await setup.flush();
  const chips = setup.renderer.root.findDescendantById("chips") as SelectRenderable;
  chips.focus();
  setup.mockInput.pressKey("q");
  await setup.waitFor(() => exitCode !== undefined);
  expect(searchAborted).toBe(true);
  expect(exitCode).toBe(0);
  setup.renderer.destroy();
});

function result(args: string[], stdout = "", stderr = ""): MiniproResult {
  return { command: ["minipro", ...args], exitCode: 0, stdout, stderr, durationMs: 1 };
}
