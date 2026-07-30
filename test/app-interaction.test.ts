import { expect, test } from "bun:test";
import { BoxRenderable, InputRenderable, SelectRenderable, TabSelectRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { ChipDeskApp } from "../src/app";
import { FakeBackend } from "./support/fake-backend";

test("uses the xgecu catalog and keeps compact navigation usable", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const backend = new FakeBackend();
  const app = new ChipDeskApp({ renderer: setup.renderer, backend, persistence: false, exit: () => undefined });
  await app.start();
  await setup.flush();

  const desktop = setup.captureCharFrame();
  expect(desktop).toContain("CHIPDESK");
  expect(desktop).toContain("01 IMAGE");
  expect(desktop).toContain("02 DEVICE CATALOG");
  expect(desktop).toContain("03 WRITE RECEIPT");
  expect(desktop).toContain("Up/Down");
  expect(desktop).toContain("AT28C64B");
  expect(desktop).toContain("28 pin DIP, elec. erasable");
  expect(desktop).toContain("28 pin DIP, UV erasable");
  expect(backend.calls).toContain("status");
  expect(backend.calls).toContain("list:AT28C64B");

  const chips = setup.renderer.root.findDescendantById("chips") as SelectRenderable;
  expect(chips.options.map(({ name, description, value }) => ({ name, description, value }))).toEqual([
    { name: "AT28C64B", description: "28 pin DIP, elec. erasable", value: "AT28C64B@DIP28" },
    { name: "M27C64A", description: "28 pin DIP, UV erasable", value: "M27C64A@DIP28" },
  ]);
  expect(chips.getSelectedOption()?.value).toBe("AT28C64B@DIP28");
  expect(backend.calls).toContain("resolve:M27C64A@DIP28");
  chips.focus();
  setup.resize(120, 24);
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Safety");
  expect(setup.captureCharFrame()).toContain("Up/Down");

  setup.resize(70, 24);
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("Safety");
  setup.mockInput.pressEnter();
  await setup.flush();
  expect(chips.focused).toBe(true);

  setup.resize(50, 24);
  await setup.flush();
  const narrow = setup.captureCharFrame();
  expect(narrow).toContain("CHIPDESK");
  expect(narrow).not.toContain("DIRECT USB");
  expect(narrow).toContain("IDLE  //  CHIP RESULTS");
  expect(narrow).toContain("28 pin DIP, elec. erasable");
  expect(narrow).toContain("28 pin DIP, UV erasable");

  setup.resize(120, 32);
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("04 OPERATION TRACE");
  setup.renderer.destroy();
});

test("search fields release focus through Escape and outside clicks", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const app = new ChipDeskApp({ renderer: setup.renderer, backend: new FakeBackend(), persistence: false, exit: () => undefined });
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

test("an empty chip search shows the full selected programmer catalog", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const backend = new FakeBackend();
  const app = new ChipDeskApp({ renderer: setup.renderer, backend, persistence: false, exit: () => undefined });
  await app.start();
  await setup.flush();

  const chipQuery = setup.renderer.root.findDescendantById("chip-query") as InputRenderable;
  const chips = setup.renderer.root.findDescendantById("chips") as SelectRenderable;
  chipQuery.value = "";
  chipQuery.focus();
  setup.mockInput.pressEnter();
  await Bun.sleep(25);
  await setup.flush();

  expect(backend.calls).toContain("list:");
  expect(chips.options.map((option) => option.value)).toEqual([
    "AT28C64B@DIP28",
    "M27C64A@DIP28",
  ]);
  setup.renderer.destroy();
});

test("unavailable actions surface an error without touching USB", async () => {
  const setup = await createTestRenderer({ width: 120, height: 32 });
  const backend = new FakeBackend();
  backend.devices.length = 0;
  const app = new ChipDeskApp({ renderer: setup.renderer, backend, persistence: false, exit: () => undefined });
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
