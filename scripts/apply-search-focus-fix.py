from pathlib import Path
from textwrap import dedent


def replace_once(text: str, old: str, new: str, label: str) -> str:
    old = dedent(old)
    new = dedent(new)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


app_path = Path("src/app.ts")
app = app_path.read_text()

app = replace_once(
    app,
    '''
      padding: 1,
      backgroundColor: BG,
    });
    ''',
    '''
      padding: 1,
      backgroundColor: BG,
      onMouseDown: (event) => this.handleWorkbenchPointerDown(event.x, event.y),
    });
    ''',
    "workbench pointer handler",
)

app = replace_once(
    app,
    '''
      if (components.fileQuery.focused || components.chipQuery.focused) {
        if (key.name === "tab") {
          consumeKey(key);
          this.focusNext();
        }
        return;
      }
    ''',
    '''
      if (components.fileQuery.focused || components.chipQuery.focused) {
        if (key.name === "escape" || key.name === "esc") {
          consumeKey(key);
          this.exitSearchInput();
          return;
        }
        if (key.name === "tab") {
          consumeKey(key);
          this.focusNext();
        }
        return;
      }
    ''',
    "search escape handling",
)

app = replace_once(
    app,
    '''
        "  E          Focus EPROM search",
        "  L          Focus the action log",
    ''',
    '''
        "  E          Focus EPROM search",
        "  Esc        Leave an active search field",
        "  Mouse      Click another pane to leave search",
        "  L          Focus the action log",
    ''',
    "help interaction model",
)

app = replace_once(
    app,
    '''
  private focusNext(): void {
    const focusables = this.focusableControls();
    ''',
    '''
  private exitSearchInput(): boolean {
    const components = this.requireComponents();
    if (components.fileQuery.focused) {
      components.files.focus();
      this.render();
      return true;
    }
    if (components.chipQuery.focused) {
      components.chipQuery.value = this.chipQuery;
      components.chips.focus();
      this.render();
      return true;
    }
    return false;
  }

  private handleWorkbenchPointerDown(x: number, y: number): void {
    const components = this.components;
    if (!components) return;
    const activeSearch = components.fileQuery.focused ? "files" : components.chipQuery.focused ? "chips" : undefined;
    if (!activeSearch) return;
    if (pointInRenderable(components.fileQuery, x, y) || pointInRenderable(components.chipQuery, x, y)) return;

    if (activeSearch === "chips") components.chipQuery.value = this.chipQuery;
    if (pointInRenderable(components.filesPanel, x, y)) components.files.focus();
    else if (pointInRenderable(components.chipPanel, x, y)) components.chips.focus();
    else if (pointInRenderable(components.logPanel, x, y)) components.log.focus();
    else if (activeSearch === "files") components.files.focus();
    else components.chips.focus();
    this.render();
  }

  private focusNext(): void {
    const focusables = this.focusableControls();
    ''',
    "search exit methods",
)

app = replace_once(
    app,
    '''
    setPanelFocus(components.filesPanel, `Files ${formatDirectoryLabel(this.fileDirectory)}`, focus === "File Search" || focus === "Files");
    setPanelFocus(components.chipPanel, "Chip Search", focus === "Chip Search" || focus === "Chip Results");
    ''',
    '''
    setPanelFocus(
      components.filesPanel,
      `Files ${formatDirectoryLabel(this.fileDirectory)}`,
      focus === "File Search" || focus === "Files",
      focus === "File Search" ? " [Enter/Esc] results " : undefined,
    );
    setPanelFocus(
      components.chipPanel,
      "Chip Search",
      focus === "Chip Search" || focus === "Chip Results",
      focus === "Chip Search" ? " [Enter] search  [Esc] results " : undefined,
    );
    ''',
    "search focus hints",
)

app = replace_once(
    app,
    '''
function setPanelFocus(panel: BoxRenderable, title: string, focused: boolean): void {
  panel.title = ` ${title} `;
  panel.titleColor = focused ? TEXT : PRIMARY;
  panel.borderStyle = focused ? "heavy" : "rounded";
  panel.borderColor = focused ? PRIMARY : BORDER;
  panel.bottomTitle = focused ? panelShortcut(panel.id) : undefined;
  panel.bottomTitleAlignment = "right";
}
    ''',
    '''
function pointInRenderable(renderable: { screenX: number; screenY: number; width: number; height: number }, x: number, y: number): boolean {
  return x >= renderable.screenX && x < renderable.screenX + renderable.width && y >= renderable.screenY && y < renderable.screenY + renderable.height;
}

function setPanelFocus(panel: BoxRenderable, title: string, focused: boolean, shortcut?: string): void {
  panel.title = ` ${title} `;
  panel.titleColor = focused ? TEXT : PRIMARY;
  panel.borderStyle = focused ? "heavy" : "rounded";
  panel.borderColor = focused ? PRIMARY : BORDER;
  panel.bottomTitle = focused ? shortcut ?? panelShortcut(panel.id) : undefined;
  panel.bottomTitleAlignment = "right";
}
    ''',
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
