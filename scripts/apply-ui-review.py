#!/usr/bin/env python3
from __future__ import annotations

import base64
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def decode(value: str) -> str:
    return zlib.decompress(base64.b64decode(value)).decode("utf-8")


app_path = ROOT / "src/app.ts"
app = app_path.read_text()
app = replace_once(app,
    '    this.footerLine = this.activeCommandCancellable ? `esc cancel | ${footerText()}` : footerText();',
    '    this.footerLine = this.activeCommandCancellable ? `[Esc] cancel  ${footerText()}` : footerText();',
    "cancellable footer")
app = replace_once(app,
    '''  private async help(): Promise<void> {
    await this.dialogs.message(
      "Help",
      [
        footerText(),
        "",
        "Defaults: T48 programmer database and AT28C64B chip query.",
        "Status: persistent operator summary for programmer, chip, image, size fit, safety options, and next action.",
        "Write path: check, erase, blank check, write, verify, readback compare, with confirmation.",
        "Read path: Shift+R, edit filename, choose Read or Cancel, then checksum is logged.",
        "Compare path: m, compare the selected local file to a temporary chip readback, then show both hashes.",
      ].join("\n"),
    );
  }''',
    '''  private async help(): Promise<void> {
    await this.dialogs.message(
      "Keyboard Reference",
      [
        "Navigation",
        "  Tab        Move focus",
        "  Enter      Activate the selected item",
        "  F          Focus file search",
        "  /          Focus chip search",
        "  L          Focus the action log",
        "",
        "Actions",
        "  R          Refresh files and programmer status",
        "  Shift+R    Read the selected chip",
        "  W          Write the selected image",
        "  M          Compare chip contents with the selected image",
        "  I          Show chip details",
        "  A          Open advanced controls",
        "",
        "Safety",
        "  Confirmations default to Cancel. Use Left/Right or Tab, then Enter.",
        "  Erase and write cannot be cancelled after those steps begin.",
        "  Defaults: T48 database and AT28C64B chip query.",
      ].join("\n"),
    );
  }''', "help content")
app = replace_once(app,
    '''    borderStyle: "single",
    borderColor: BORDER,
    focusedBorderColor: BORDER_ACTIVE,''',
    '''    borderStyle: "rounded",
    borderColor: BORDER,
    focusedBorderColor: PRIMARY,''', "panel border defaults")
app = replace_once(app,
    '''    showScrollIndicator: true,
    wrapSelection: true,''',
    '''    showScrollIndicator: true,
    showSelectionIndicator: false,
    wrapSelection: true,''', "select indicator")
app = replace_once(app,
    '''function footerText(): string {
  return "q quit | tab focus | enter/space select | f files | / chips | i info | l log | r refresh | w write | m compare | R read | ? help";
}''',
    '''function footerText(): string {
  return "[Tab] focus  [Enter] select  [F] files  [/] chips  [W] write  [Shift+R] read  [M] compare  [?] help  [Q] quit";
}''', "footer shortcuts")
app = replace_once(app,
    '''function setPanelFocus(panel: BoxRenderable, title: string, focused: boolean): void {
  panel.title = focused ? ` > ${title} ` : ` ${title} `;
  panel.titleColor = focused ? TEXT : PRIMARY;
  panel.borderColor = focused ? PRIMARY : BORDER;
}''',
    '''function setPanelFocus(panel: BoxRenderable, title: string, focused: boolean): void {
  panel.title = ` ${title} `;
  panel.titleColor = focused ? TEXT : PRIMARY;
  panel.borderStyle = focused ? "heavy" : "rounded";
  panel.borderColor = focused ? PRIMARY : BORDER;
  panel.bottomTitle = focused ? panelShortcut(panel.id) : undefined;
  panel.bottomTitleAlignment = "right";
}

function panelShortcut(id: string): string | undefined {
  switch (id) {
    case "files-panel": return " [Enter] open  [Space] choose  [Backspace] up ";
    case "chip-panel": return " [Enter] choose  [/] search  [I] details ";
    case "log-panel": return " [↑/↓] scroll  [L] focus ";
    default: return undefined;
  }
}''', "panel focus chrome")
app_path.write_text(app)

(ROOT / "src/tui/dialogs.ts").write_text(decode("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"))
(ROOT / "test/dialogs.test.ts").write_text(decode("eNrVV+9u2zYQ/96n4LShkFFXlh2vyBJ4W+ulwLCiAbIA/TJgpaWzxUUiPZKK4xl+jD3GXmpPsjtStuVGtZwhLTbzi3B3JH/353c8i2KutGUrBndzSGyXWTCWrdlUq4IFk1KekSA4fyI2hokGbuEapVcgU9Cgt+bfqzlIW4peojT0aKOQM9y72/yD4LmajZW0WuV5bWsU9YxOerQ5dTaG9iVKIhqbQQFsxFZPGJtrUXC9PGPBl9PpKY/joEtSLiEnWX9Iy8kgx13SOinQqktfq6Q0kJJycErLKSdKo0MvEytugVQvYlpOZeHOHQXu50QGz0ospNeVKua0nKoorT/8NKaFsjV6QwEJA/RpKnTBrVCSaRdCw3h1N6SsUCnP2ULYjBk+hS67geVEcZ0+TzXikowntNUEXcbNUiYs7LDRty44PlwGbDnHcPEFF7YhXeEKT09tdsZO4y7LQMwyxD8YsnXnHA/JwTLKI0IZsXgjSXJldhJ/UZUoFEpY3EttSIgYm8H24rMKqgMY6UradWYux/5TyUu8fmPsoTx7ttGNCchG6VF5JaHfQku4TABREOIKZlQFPgzeaWGBjTMxxxgGV3ArED4CoLu0ywvJnVXgQuIj6WFP89JkYWcXBSGFxRvwIm+Q8LktNYwzrl9rXoC39fQKK+NOZBVFigsZBn//+VfQZlOD3GY6dq4fd2Kr1dvehUm8lfeuUMnNj3Je2miuwZgLaTHT9VOqqtvEn057BeGU5wb2EuST8WkT1Aj5pdZqEQaayv7feLYBXnlmddns2Kvlzxk2vaS0n93Fn2AZBsvgAPgduH03tvaedpXypK7xnNvT7BM6SrHZaLUkgI6Uvu/lSs5Ygej4DAiIxTbMTELNAvufTBkYpA5gSzQWnw/jbFD7CH3u61qf67+o9bltV3P1+Zk7W4lWU4FRbmxtqx04ys05W2+aXK3SXAxHDEuaLyN6SNHnHOSMnD6JcQsLf+1ih0rhzh36Psf72FcrJ1m/70S/KWL5LzKol/AmSbuyrSRh8IaSeFlaLDXMS4XgUH1WRfOx1rjXbBy4OGilbqoW8iFWjwVtcKhduOINa/dVMfsYc7aEO4o8RMdtVRrLl5hUI1JwLQMbVSEkPkF8ip9EIPEHfKrx4D9DkD1tHduB8r2i0PBJTtE5njQbojXypr05+3yEJ4Mu6w/a5wk//40+rAutlI0wovhk5ClKw06E3qdhmJDAT0P0FYk0wgLR1rzDETIM3HHPgw57+pR9ccBiwpObVKt55VFVsk73XeQKwhfuG4zldcblpb74veR5eBI32Puqad7wzYPJ557itkHkEP+OotjeXF69PQbJVCAGdiuMwLKpGGYyLeQN/rfBud09awiBHvBH4Fw/rpGOqvF/Qrq96LXNO43UGzZTryhoNmik3gMGpIqDQwxuf9jOwSlV4XETvTNtG8DvG90fv+/bvH1AzTeNeS4ZHwzgbWT4B8aFRGA="))

interaction_path = ROOT / "test/app-interaction.test.ts"
interaction = interaction_path.read_text()
interaction = replace_once(interaction,
    '''  expect(desktop).toContain("Actions / Log");
  expect(desktop).toContain("Safety");''',
    '''  expect(desktop).toContain("Actions / Log");
  expect(desktop).toContain("Safety");
  expect(desktop).toContain("╭");
  expect(desktop).toContain("┏");
  expect(desktop).toContain("[Tab] focus");
  expect(desktop).toContain("[Enter] open");''', "desktop chrome assertions")
interaction_path.write_text(interaction)
