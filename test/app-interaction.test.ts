import { expect, test } from "bun:test";
import { BoxRenderable, InputRenderable, SelectRenderable, TabSelectRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { MiniproTuiApp } from "../src/app";
import { FakeBackend } from "./support/fake-backend";

test("uses the xgecu catalog and keeps compact navigation usable", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const backend = new FakeBackend();
  const app = new MiniproTuiApp({ renderer: setup.renderer, backend, persistence: false, exit: () => undefined });
  await app.start();
  await setup.flush();

  const desktop = setup.captureCharFrame();
  expect(desktop).toContain("MINIPRO");
  expect(desktop).toContain("Chip Search");
  expect(desktop).toContain("AT28C64B@DIP28");
  expect(backend.calls).toContain("status");
  expect(backend.calls).toContain("list:AT28C64B");

  const chips = setup.renderer.root.findDescendantById("chips") as SelectRenderable;
  chips.focus();
  setup.resize(70, 24);
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Status");
  setup.mockInput.pressEnter();
  await setup.flush();
  expect(chips.focused).toBe(true);

  setup.resize(120, 32);
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Actions / Log");
  setup.renderer.destroy();
});

test("search fields release focus through Escape and outside clicks", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const app = new MiniproTuiApp({ renderer: setup.renderer, backend: new FakeBackend(), persistence: false, exit: () => undefined });
  await app.start();
  await setup.flush();

  const fileQuery = setup.renderer.root.findDescendantById("file-query") as InputRenderable;
  const files = setup.renderer.root.findDescendantById("files") as SelectRenderable;
  const chipQuery = setup.renderer.root.findDescendantById("chip-query") as InputRenderable;
  const statusPanel = setup.renderer.root.findDescendantById("status-panel") as BoxRenderable;
  setup.mockInput.pressKey("f");
  setup.mockInput.pressKey("q");
  await setup.flush();
  expect(fileQuery.focused).toBe(true);
  setup.mockInput.pressEscape();
  await Bun.sleep(25);
  await setup.flush();
  expect(files.focused).toBe(true);

  chipQuery.focus();
  await setup.mockMouse.click(statusPanel.screenX + 2, statusPanel.screenY + 2);
  await setup.flush();
  expect(chipQuery.focused).toBe(false);
  setup.renderer.destroy();
});

test("unavailable actions surface an error without touching USB", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const backend = new FakeBackend();
  const app = new MiniproTuiApp({ renderer: setup.renderer, backend, persistence: false, exit: () => undefined });
  await app.start();
  await setup.flush();
  const files = setup.renderer.root.findDescendantById("files") as SelectRenderable;
  files.focus();
  setup.mockInput.pressKey("w");
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Action needed:");
  expect(backend.calls).not.toContain("write");
  setup.renderer.destroy();
});
