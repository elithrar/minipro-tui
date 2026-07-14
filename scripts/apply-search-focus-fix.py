from pathlib import Path
from textwrap import dedent


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


app_path = Path("src/app.ts")
app = app_path.read_text()

app = replace_once(
    app,
    "      backgroundColor: BG,\n    });\n\n    const compactTabs",
    "      backgroundColor: BG,\n      onMouseDown: (event) => this.handleWorkbenchPointerDown(event.x, event.y),\n    });\n\n    const compactTabs",
    "workbench pointer handler",
)

app = replace_once(
    app,
    "      if (components.fileQuery.focused || components.chipQuery.focused) {\n"
    "        if (key.name === \"tab\") {\n"
    "          consumeKey(key);\n"
    "          this.focusNext();\n"
    "        }\n"
    "        return;\n"
    "      }",
    "      if (components.fileQuery.focused || components.chipQuery.focused) {\n"
    "        if (key.name === \"escape\" || key.name === \"esc\") {\n"
    "          consumeKey(key);\n"
    "          this.exitSearchInput();\n"
    "          return;\n"
    "        }\n"
    "        if (key.name === \"tab\") {\n"
    "          consumeKey(key);\n"
    "          this.focusNext();\n"
    "        }\n"
    "        return;\n"
    "      }",
    "search escape handling",
)

app = replace_once(
    app,
    '        "  E          Focus EPROM search",\n        "  L          Focus the action log",',
    '        "  E          Focus EPROM search",\n'
    '        "  Esc        Leave an active search field",\n'
    '        "  Mouse      Click another pane to leave search",\n'
    '        "  L          Focus the action log",',
    "help interaction model",
)

app = replace_once(
    app,
    "  private focusNext(): void {\n    const focusables = this.focusableControls();",
    "  private exitSearchInput(): boolean {\n"
    "    const components = this.requireComponents();\n"
    "    if (components.fileQuery.focused) {\n"
    "      components.files.focus();\n"
    "      this.render();\n"
    "      return true;\n"
    "    }\n"
    "    if (components.chipQuery.focused) {\n"
    "      components.chipQuery.value = this.chipQuery;\n"
    "      components.chips.focus();\n"
    "      this.render();\n"
    "      return true;\n"
    "    }\n"
    "    return false;\n"
    "  }\n\n"
    "  private handleWorkbenchPointerDown(x: number, y: number): void {\n"
    "    const components = this.components;\n"
    "    if (!components) return;\n"
    "    const activeSearch = components.fileQuery.focused ? \"files\" : components.chipQuery.focused ? \"chips\" : undefined;\n"
    "    if (!activeSearch) return;\n"
    "    if (pointInRenderable(components.fileQuery, x, y) || pointInRenderable(components.chipQuery, x, y)) return;\n\n"
    "    if (activeSearch === \"chips\") components.chipQuery.value = this.chipQuery;\n"
    "    if (pointInRenderable(components.filesPanel, x, y)) components.files.focus();\n"
    "    else if (pointInRenderable(components.chipPanel, x, y)) components.chips.focus();\n"
    "    else if (pointInRenderable(components.logPanel, x, y)) components.log.focus();\n"
    "    else if (activeSearch === \"files\") components.files.focus();\n"
    "    else components.chips.focus();\n"
    "    this.render();\n"
    "  }\n\n"
    "  private focusNext(): void {\n"
    "    const focusables = this.focusableControls();",
    "search exit methods",
)

app = replace_once(
    app,
    "    setPanelFocus(components.filesPanel, `Files ${formatDirectoryLabel(this.fileDirectory)}`, focus === \"File Search\" || focus === \"Files\");\n"
    "    setPanelFocus(components.chipPanel, \"Chip Search\", focus === \"Chip Search\" || focus === \"Chip Results\");",
    "    setPanelFocus(\n"
    "      components.filesPanel,\n"
    "      `Files ${formatDirectoryLabel(this.fileDirectory)}`,\n"
    "      focus === \"File Search\" || focus === \"Files\",\n"
    "      focus === \"File Search\" ? \" [Enter/Esc] results \" : undefined,\n"
    "    );\n"
    "    setPanelFocus(\n"
    "      components.chipPanel,\n"
    "      \"Chip Search\",\n"
    "      focus === \"Chip Search\" || focus === \"Chip Results\",\n"
    "      focus === \"Chip Search\" ? \" [Enter] search  [Esc] results \" : undefined,\n"
    "    );",
    "search focus hints",
)

app = replace_once(
    app,
    "function setPanelFocus(panel: BoxRenderable, title: string, focused: boolean): void {\n"
    "  panel.title = ` ${title} `;\n"
    "  panel.titleColor = focused ? TEXT : PRIMARY;\n"
    "  panel.borderStyle = focused ? \"heavy\" : \"rounded\";\n"
    "  panel.borderColor = focused ? PRIMARY : BORDER;\n"
    "  panel.bottomTitle = focused ? panelShortcut(panel.id) : undefined;\n"
    "  panel.bottomTitleAlignment = \"right\";\n"
    "}",
    "function pointInRenderable(renderable: { screenX: number; screenY: number; width: number; height: number }, x: number, y: number): boolean {\n"
    "  return x >= renderable.screenX && x < renderable.screenX + renderable.width && y >= renderable.screenY && y < renderable.screenY + renderable.height;\n"
    "}\n\n"
    "function setPanelFocus(panel: BoxRenderable, title: string, focused: boolean, shortcut?: string): void {\n"
    "  panel.title = ` ${title} `;\n"
    "  panel.titleColor = focused ? TEXT : PRIMARY;\n"
    "  panel.borderStyle = focused ? \"heavy\" : \"rounded\";\n"
    "  panel.borderColor = focused ? PRIMARY : BORDER;\n"
    "  panel.bottomTitle = focused ? shortcut ?? panelShortcut(panel.id) : undefined;\n"
    "  panel.bottomTitleAlignment = \"right\";\n"
    "}",
    "pointer geometry and focus hints",
)

app_path.write_text(app)

test_path = Path("test/app-interaction.test.ts")
test = test_path.read_text()
test = replace_once(
    test,
    'import { InputRenderable, SelectRenderable } from "@opentui/core";',
    'import { BoxRenderable, InputRenderable, SelectRenderable } from "@opentui/core";',
    "test imports",
)

marker = 'test("compact chip shortcut moves focus before a slow search completes", async () => {'
new_test = dedent('''
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
  const statusPanel = setup.renderer.root.findDescendantById("status-panel") as BoxRenderable;
  setup.mockInput.pressKey("f");
  setup.mockInput.pressKey("q");
  await setup.flush();
  expect(fileQuery.focused).toBe(true);
  expect(setup.captureCharFrame()).toContain("[Enter/Esc] results");

  setup.mockInput.pressEscape();
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

  const chipQuery = setup.renderer.root.findDescendantById("chip-query") as InputRenderable;
  const chips = setup.renderer.root.findDescendantById("chips") as SelectRenderable;
  chipQuery.focus();
  chipQuery.value = "unsubmitted query";
  setup.mockInput.pressEscape();
  await setup.flush();
  expect(chipQuery.focused).toBe(false);
  expect(chips.focused).toBe(true);
  expect(chipQuery.value).toBe("AT28C64B");
  setup.renderer.destroy();
});

''') + marker
test = replace_once(test, marker, new_test, "search focus interaction test")
test_path.write_text(test)
