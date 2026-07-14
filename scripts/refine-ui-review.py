#!/usr/bin/env python3
from pathlib import Path


def replace_optional(text: str, old: str, new: str) -> str:
    if old in text:
        return text.replace(old, new, 1)
    if new not in text:
        raise RuntimeError(f"expected either old or new UI fragment:\n{old}")
    return text


dialogs_path = Path("src/tui/dialogs.ts")
dialogs = dialogs_path.read_text()
dialogs = replace_optional(dialogs, "Math.max(3, maxHeight - 10)", "Math.max(3, maxHeight - 11)")
dialogs = replace_optional(dialogs, "this.modalBox(renderer, title, textHeight + 10)", "this.modalBox(renderer, title, textHeight + 11)")
dialogs = replace_optional(
    dialogs,
    '''    modal.add(this.shortcutBar(renderer, [
      { key: "←/→", label: "choose" },
      { key: "Enter", label: "activate" },
      { key: "Y", label: "confirm" },
      { key: "N/Esc", label: "cancel" },
    ]));''',
    '''    modal.add(this.shortcutBar(renderer, [
      { key: "←/→", label: "choose" },
      { key: "Enter", label: "activate" },
    ]));
    modal.add(this.shortcutBar(renderer, [
      { key: "Y", label: "confirm" },
      { key: "N/Esc", label: "cancel" },
    ]));''',
)
dialogs = replace_optional(
    dialogs,
    "textHeight + 10, (height) => { body.height = Math.max(1, height - 10); }",
    "textHeight + 11, (height) => { body.height = Math.max(1, height - 11); }",
)
dialogs_path.write_text(dialogs)

app_path = Path("src/app.ts")
app = app_path.read_text()
app = replace_optional(
    app,
    'case "files-panel": return " [Enter] open  [Space] choose  [Backspace] up ";',
    'case "files-panel": return " [Enter] open ";',
)
app = replace_optional(
    app,
    'case "chip-panel": return " [Enter] choose  [/] search  [I] details ";',
    'case "chip-panel": return " [Enter] choose ";',
)
app = replace_optional(
    app,
    'case "log-panel": return " [↑/↓] scroll  [L] focus ";',
    'case "log-panel": return " [↑/↓] scroll ";',
)
app_path.write_text(app)
