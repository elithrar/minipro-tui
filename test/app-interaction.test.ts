import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, InputRenderable, SelectRenderable, TabSelectRenderable } from "@opentui/core";

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
  expect(desktop).toContain("[↑/↓] browse");
  expect(desktop).toContain("[Enter] open");
  expect(desktop).toContain("[/] chips");
  expect(desktop).toContain("Next: choose an image in Files.");

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


test("search fields release focus through Escape and outside clicks", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const app = new MiniproTuiApp({
    renderer: setup.renderer,
    persistence: false,
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

  const fileQuery = setup.renderer.root.findDescendantById("file-query") as InputRenderable;
  const files = setup.renderer.root.findDescendantById("files") as SelectRenderable;
  const chipQuery = setup.renderer.root.findDescendantById("chip-query") as InputRenderable;
  const chips = setup.renderer.root.findDescendantById("chips") as SelectRenderable;
  const statusPanel = setup.renderer.root.findDescendantById("status-panel") as BoxRenderable;

  expect(files.focused).toBe(true);
  await setup.mockMouse.click(chipQuery.screenX + 1, chipQuery.screenY);
  await setup.flush();
  expect(chipQuery.focused).toBe(true);

  await setup.mockMouse.click(fileQuery.screenX + 1, fileQuery.screenY);
  await setup.flush();
  expect(fileQuery.focused).toBe(true);

  fileQuery.value = "";
  files.focus();
  setup.resize(70, 24);
  await setup.flush();
  const compactTabs = setup.renderer.root.findDescendantById("compact-tabs") as TabSelectRenderable;
  await setup.mockMouse.click(compactTabs.screenX + 11, compactTabs.screenY);
  await setup.flush();
  expect(chipQuery.focused).toBe(true);

  setup.resize(120, 32);
  await setup.flush();
  files.focus();

  setup.mockInput.pressKey("f");
  setup.mockInput.pressKey("q");
  await setup.flush();
  expect(fileQuery.focused).toBe(true);
  expect(setup.captureCharFrame()).toContain("[Enter/Esc] results");

  setup.mockInput.pressEscape();
  await Bun.sleep(25);
  await setup.flush();
  expect(fileQuery.focused).toBe(false);
  expect(files.focused).toBe(true);
  expect(fileQuery.value).toBe("q");

  setup.mockInput.pressKey("f");
  await setup.flush();
  await setup.mockMouse.click(statusPanel.screenX + 2, statusPanel.screenY + 2);
  await setup.flush();
  expect(fileQuery.focused).toBe(false);
  expect(files.focused).toBe(true);

  chipQuery.focus();
  chipQuery.value = "unsubmitted query";
  setup.mockInput.pressEscape();
  await Bun.sleep(25);
  await setup.flush();
  expect(chipQuery.focused).toBe(false);
  expect(chips.focused).toBe(true);
  expect(chipQuery.value).toBe("AT28C64B");
  setup.renderer.destroy();
});

test("chip search shows progress and results stay usable while details load", async () => {
  const setup = await createTestRenderer({ width: 70, height: 24 });
  let delaySearch = false;
  let releaseSearch: () => void = () => undefined;
  let delayDetails = false;
  let releaseDetails: () => void = () => undefined;
  let reportDetailsStarted: () => void = () => undefined;
  const searchGate = new Promise<void>((resolve) => { releaseSearch = () => resolve(); });
  const detailsGate = new Promise<void>((resolve) => { releaseDetails = () => resolve(); });
  const detailsStarted = new Promise<void>((resolve) => { reportDetailsStarted = () => resolve(); });
  const app = new MiniproTuiApp({
    renderer: setup.renderer,
    persistence: false,
    commandRunner: async (args) => {
      if (args[0] === "-Q") return result(args, await Bun.file("fixtures/minipro-q.txt").text());
      if (args[0] === "-k") return result(args, await Bun.file("fixtures/minipro-k-none.txt").text());
      if (args.includes("-L")) {
        if (delaySearch) {
          await searchGate;
          return result(args, "NEWCHIP\n");
        }
        return result(args, await Bun.file("fixtures/minipro-l-at28c64b.txt").text());
      }
      if (args.includes("-d")) {
        if (delayDetails) {
          reportDetailsStarted();
          await detailsGate;
        }
        return result(args, "", await Bun.file("fixtures/minipro-d-at28c64b.txt").text());
      }
      return result(args);
    },
  });
  await app.start();
  setup.mockInput.pressKey("f");
  await setup.flush();
  delaySearch = true;
  delayDetails = true;
  const files = setup.renderer.root.findDescendantById("files") as SelectRenderable;
  files.focus();
  setup.mockInput.pressKey("/");
  await setup.flush();

  const chipQuery = setup.renderer.root.findDescendantById("chip-query") as InputRenderable;
  expect(chipQuery.focused).toBe(true);
  expect(setup.captureCharFrame()).toContain("Chip Search");
  setup.mockInput.pressEnter();
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Searching chips...");
  releaseSearch();
  await searchGate;
  await Bun.sleep(0);
  await detailsStarted;
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Loading chip details; results are ready to browse.");
  expect(setup.captureCharFrame()).toContain("AT28C64B");
  releaseDetails();
  await Bun.sleep(0);
  setup.renderer.destroy();
});

test("Shift+Tab moves focus backward and unavailable actions show foreground errors", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const app = new MiniproTuiApp({
    renderer: setup.renderer,
    persistence: false,
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

  const files = setup.renderer.root.findDescendantById("files") as SelectRenderable;
  const fileQuery = setup.renderer.root.findDescendantById("file-query") as InputRenderable;
  expect(files.focused).toBe(true);
  setup.mockInput.pressTab({ shift: true });
  await setup.flush();
  expect(fileQuery.focused).toBe(true);
  expect(setup.captureCharFrame()).toContain("[Tab/Shift+Tab] focus");

  setup.mockInput.pressEscape();
  await Bun.sleep(25);
  await setup.flush();
  expect(files.focused).toBe(true);
  setup.mockInput.pressKey("w");
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Action needed: Select an image before writing.");
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
  setup.mockInput.pressKey("/");
  setup.mockInput.pressEnter();
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
