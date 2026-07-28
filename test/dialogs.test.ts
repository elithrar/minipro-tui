import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { DialogController } from "../src/tui/dialogs";

const theme = {
  primary: "#ff8a00",
  panel: "#141414",
  element: "#1e1e1e",
  elementFocused: "#282828",
  borderActive: "#606060",
  text: "#eeeeee",
  selectedText: "#0a0a0a",
  muted: "#808080",
};

test("confirmation renders bordered controls with safe keyboard defaults", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  let opened = 0;
  let closed = 0;
  const dialogs = new DialogController({
    getRenderer: () => setup.renderer,
    theme,
    onOpen: () => opened++,
    onClose: () => closed++,
  });

  const cancelled = dialogs.confirm("Write Chip", "Review the operation", "Write");
  await setup.flush();
  const initial = setup.captureCharFrame();
  expect(initial).toContain("╭");
  expect(initial).toContain("Write Chip");
  expect(initial).toContain("Cancel");
  expect(initial).toContain("Write");
  expect(initial).toContain("N/Esc");
  setup.mockInput.pressEnter();
  expect(await cancelled).toBe(false);

  const confirmed = dialogs.confirm("Write Chip", "Review the operation", "Write");
  await setup.flush();
  setup.mockInput.pressArrow("right");
  setup.mockInput.pressEnter();
  expect(await confirmed).toBe(true);

  const confirmedByShortcut = dialogs.confirm("Write Chip", "Review the operation", "Write");
  await setup.flush();
  setup.mockInput.pressKey("y");
  expect(await confirmedByShortcut).toBe(true);

  const confirmedAfterWrapping = dialogs.confirm("Write Chip", "Review the operation", "Write");
  await setup.flush();
  setup.mockInput.pressTab({ shift: true });
  setup.mockInput.pressEnter();
  expect(await confirmedAfterWrapping).toBe(true);
  expect(opened).toBe(4);
  expect(closed).toBe(4);
  setup.renderer.destroy();
});

test("long message content scrolls and escape restores control", async () => {
  const setup = await createTestRenderer({ width: 50, height: 16 });
  let closed = false;
  const dialogs = new DialogController({
    getRenderer: () => setup.renderer,
    theme,
    onOpen: () => undefined,
    onClose: () => { closed = true; },
  });
  const content = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");

  const message = dialogs.message("Long Output", content);
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("line 0");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressArrow("down");
  await setup.flush();
  expect(setup.captureCharFrame()).toContain("line 2");
  setup.mockInput.pressEscape();
  await message;
  expect(closed).toBe(true);
  setup.renderer.destroy();
});

test("open dialogs stay inside the terminal after resize", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const dialogs = new DialogController({
    getRenderer: () => setup.renderer,
    theme,
    onOpen: () => undefined,
    onClose: () => undefined,
  });
  const message = dialogs.message("Resizable", Array.from({ length: 30 }, (_, index) => `content ${index}`).join("\n"));
  await setup.flush();
  setup.resize(32, 12);
  await setup.flush();
  const modal = setup.renderer.root.findDescendantById("modal-1");
  expect(modal?.width).toBeLessThanOrEqual(30);
  expect(modal?.height).toBeLessThanOrEqual(9);
  expect(setup.captureCharFrame()).toContain("Enter/Esc");
  setup.mockInput.pressEscape();
  await message;
  setup.renderer.destroy();
});

test("confirmation controls remain visible after shrinking a long preview", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30 });
  const dialogs = new DialogController({
    getRenderer: () => setup.renderer,
    theme,
    onOpen: () => undefined,
    onClose: () => undefined,
  });
  const confirmation = dialogs.confirm("Write Chip", Array.from({ length: 40 }, (_, index) => `command ${index}`).join("\n"), "Write");
  await setup.flush();
  setup.resize(40, 14);
  await setup.flush();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Cancel");
  expect(frame).toContain("Write");
  expect(frame).toContain("N/Esc");
  setup.mockInput.pressEscape();
  expect(await confirmation).toBe(false);
  setup.renderer.destroy();
});
