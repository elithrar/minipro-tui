import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  StyledText,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core";

export type DialogTheme = {
  primary: string;
  panel: string;
  element: string;
  elementFocused: string;
  borderActive: string;
  text: string;
  selectedText: string;
  muted: string;
};

export type DialogControllerOptions = {
  getRenderer: () => CliRenderer;
  theme: DialogTheme;
  onOpen: () => void;
  onClose: () => void;
};

type ConfirmChoice = "cancel" | "confirm";
type Shortcut = { key: string; label: string };

export class DialogController {
  private nextModalId = 0;

  constructor(private readonly options: DialogControllerOptions) {}

  async confirm(title: string, content: string, confirmLabel: string): Promise<boolean> {
    const renderer = this.options.getRenderer();
    this.options.onOpen();
    const maxHeight = maxModalHeight(renderer);
    const textHeight = clamp(estimateWrappedRows(content, modalInnerWidth(renderer)), 3, Math.max(3, maxHeight - 10));
    const modal = this.modalBox(renderer, title, textHeight + 10);
    const body = this.scrollableText(renderer, content, textHeight);
    body.marginBottom = 1;
    modal.add(body);

    const buttonRow = new BoxRenderable(renderer, {
      id: `modal-buttons-${this.nextModalId}`,
      width: "100%",
      height: 3,
      flexDirection: "row",
      justifyContent: "flex-end",
      backgroundColor: this.options.theme.panel,
      columnGap: 1,
      marginBottom: 1,
    });
    const cancelButton = this.button(renderer, "Cancel", Math.max(10, "Cancel".length + 4));
    const confirmButton = this.button(renderer, confirmLabel, Math.max(10, confirmLabel.length + 4));
    buttonRow.add(cancelButton.box);
    buttonRow.add(confirmButton.box);
    modal.add(buttonRow);
    modal.add(this.shortcutBar(renderer, [
      { key: "←/→", label: "choose" },
      { key: "Enter", label: "activate" },
      { key: "Y", label: "confirm" },
      { key: "N/Esc", label: "cancel" },
    ]));

    const backdrop = this.backdropBox(renderer);
    const unmount = this.mountModal(renderer, modal, backdrop, textHeight + 10, (height) => { body.height = Math.max(1, height - 10); });

    return new Promise((resolve) => {
      let settled = false;
      let active: ConfirmChoice = "cancel";
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        modal.onKeyDown = undefined;
        modal.blur();
        unmount();
        this.closeModal(renderer, modal, backdrop);
        this.options.onClose();
        resolve(value);
      };
      const renderButtons = () => {
        this.setButtonState(cancelButton, active === "cancel");
        this.setButtonState(confirmButton, active === "confirm");
        renderer.root.requestRender();
      };
      modal.onKeyDown = (key: KeyEvent) => {
        if (isCancelKey(key) || isKey(key, "q") || isKey(key, "n")) {
          consumeKey(key);
          done(false);
          return;
        }
        if (isKey(key, "y")) {
          consumeKey(key);
          done(true);
          return;
        }
        if (isKey(key, "left") || (isKey(key, "tab") && active === "confirm")) {
          consumeKey(key);
          active = "cancel";
          renderButtons();
          return;
        }
        if (isKey(key, "right") || (isKey(key, "tab") && active === "cancel")) {
          consumeKey(key);
          active = "confirm";
          renderButtons();
          return;
        }
        if (isKey(key, "up")) {
          body.scrollBy(-1);
          return;
        }
        if (isKey(key, "down")) {
          body.scrollBy(1);
          return;
        }
        if (isSubmitKey(key)) {
          consumeKey(key);
          done(active === "confirm");
        }
      };
      modal.focusable = true;
      modal.focus();
      renderButtons();
    });
  }

  async filename(title: string, initialValue: string): Promise<string | undefined> {
    const renderer = this.options.getRenderer();
    this.options.onOpen();
    const modal = this.modalBox(renderer, title, 9);
    modal.add(new TextRenderable(renderer, { content: "Output filename", width: "100%", height: 1, fg: this.options.theme.muted, bg: this.options.theme.panel }));
    const input = new InputRenderable(renderer, {
      value: initialValue,
      width: "100%",
      backgroundColor: this.options.theme.element,
      focusedBackgroundColor: this.options.theme.elementFocused,
      textColor: this.options.theme.text,
      cursorColor: this.options.theme.primary,
      marginTop: 1,
      marginBottom: 1,
    });
    modal.add(input);
    modal.add(this.shortcutBar(renderer, [
      { key: "Enter", label: "accept" },
      { key: "Esc", label: "cancel" },
    ]));
    const backdrop = this.backdropBox(renderer);
    const unmount = this.mountModal(renderer, modal, backdrop, 9);

    return new Promise((resolve) => {
      let settled = false;
      const done = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        input.onKeyDown = undefined;
        input.off(InputRenderableEvents.ENTER, submit);
        input.blur();
        unmount();
        this.closeModal(renderer, modal, backdrop);
        this.options.onClose();
        resolve(value);
      };
      const submit = (value: string) => done(value.trim() || undefined);
      input.on(InputRenderableEvents.ENTER, submit);
      input.onKeyDown = (key: KeyEvent) => {
        if (isCancelKey(key)) {
          consumeKey(key);
          done(undefined);
        }
      };
      setTimeout(() => {
        if (settled) return;
        input.focus();
        renderer.root.requestRender();
      }, 0);
    });
  }

  async select(title: string, options: SelectOption[], selectedIndex = 0): Promise<SelectOption | undefined> {
    const renderer = this.options.getRenderer();
    this.options.onOpen();
    const rowsPerOption = options.some((option) => option.description) ? 2 : 1;
    const desiredSelectHeight = Math.max(4, options.length * rowsPerOption);
    const modalHeight = clamp(desiredSelectHeight + 7, 10, maxModalHeight(renderer));
    const modal = this.modalBox(renderer, title, modalHeight);
    const select = new SelectRenderable(renderer, {
      ...this.selectOptions("modal-select", Math.max(4, modalHeight - 7)),
      options,
      selectedIndex: Math.max(0, selectedIndex),
    });
    modal.add(select);
    modal.add(this.shortcutBar(renderer, [
      { key: "↑/↓", label: "move" },
      { key: "Enter", label: "select" },
      { key: "Esc", label: "cancel" },
    ], 1));
    const backdrop = this.backdropBox(renderer);
    const unmount = this.mountModal(renderer, modal, backdrop, modalHeight, (height) => { select.height = Math.max(1, height - 7); });

    return new Promise((resolve) => {
      let settled = false;
      const done = (value: SelectOption | undefined) => {
        if (settled) return;
        settled = true;
        select.onKeyDown = undefined;
        select.off(SelectRenderableEvents.ITEM_SELECTED, selected);
        select.blur();
        unmount();
        this.closeModal(renderer, modal, backdrop);
        this.options.onClose();
        resolve(value);
      };
      const selected = (_index: number, option: SelectOption) => done(option);
      select.on(SelectRenderableEvents.ITEM_SELECTED, selected);
      select.onKeyDown = (key: KeyEvent) => {
        if (isCancelKey(key) || isKey(key, "q")) {
          consumeKey(key);
          done(undefined);
        }
      };
      select.focus();
    });
  }

  async message(title: string, content: string): Promise<void> {
    const renderer = this.options.getRenderer();
    this.options.onOpen();
    const maxHeight = maxModalHeight(renderer);
    const textHeight = clamp(estimateWrappedRows(content, modalInnerWidth(renderer)), 3, Math.max(3, maxHeight - 7));
    const modal = this.modalBox(renderer, title, textHeight + 7);
    const body = this.scrollableText(renderer, content, textHeight);
    body.marginBottom = 1;
    modal.add(body);
    modal.add(this.shortcutBar(renderer, [
      { key: "↑/↓", label: "scroll" },
      { key: "Enter/Esc", label: "close" },
    ]));
    const backdrop = this.backdropBox(renderer);
    const unmount = this.mountModal(renderer, modal, backdrop, textHeight + 7, (height) => { body.height = Math.max(1, height - 7); });

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        body.onKeyDown = undefined;
        body.blur();
        unmount();
        this.closeModal(renderer, modal, backdrop);
        this.options.onClose();
        resolve();
      };
      body.onKeyDown = (key: KeyEvent) => {
        if (isCancelKey(key) || isKey(key, "q") || isSubmitKey(key)) {
          consumeKey(key);
          done();
        }
      };
      body.focus();
    });
  }

  private modalBox(renderer: CliRenderer, title: string, height: number): BoxRenderable {
    const modalHeight = clamp(height, 7, maxModalHeight(renderer));
    const width = modalWidth(renderer);
    return new BoxRenderable(renderer, {
      id: `modal-${++this.nextModalId}`,
      position: "absolute",
      zIndex: 100,
      top: Math.max(0, Math.floor((renderer.height - modalHeight) / 2)),
      left: Math.max(0, Math.floor((renderer.width - width) / 2)),
      width,
      height: modalHeight,
      border: true,
      borderStyle: "rounded",
      borderColor: this.options.theme.borderActive,
      focusedBorderColor: this.options.theme.primary,
      title: ` ${title} `,
      titleColor: this.options.theme.primary,
      titleAlignment: "left",
      backgroundColor: this.options.theme.panel,
      padding: 1,
      flexDirection: "column",
    });
  }

  private mountModal(renderer: CliRenderer, modal: BoxRenderable, backdrop: BoxRenderable, desiredHeight: number, resizeContent?: (height: number) => void): () => void {
    const resize = () => {
      const width = modalWidth(renderer);
      const height = clamp(desiredHeight, 1, maxModalHeight(renderer));
      modal.width = width;
      modal.height = height;
      modal.left = Math.max(0, Math.floor((renderer.width - width) / 2));
      modal.top = Math.max(0, Math.floor((renderer.height - height) / 2));
      backdrop.width = renderer.width;
      backdrop.height = renderer.height;
      resizeContent?.(height);
      renderer.root.requestRender();
    };
    renderer.root.add(backdrop);
    renderer.root.add(modal);
    renderer.on(CliRenderEvents.RESIZE, resize);
    resize();
    return () => renderer.off(CliRenderEvents.RESIZE, resize);
  }

  private scrollableText(renderer: CliRenderer, content: string, height: number): ScrollBoxRenderable {
    const scroll = new ScrollBoxRenderable(renderer, {
      width: "100%",
      height,
      scrollY: true,
      rootOptions: { backgroundColor: this.options.theme.panel },
      viewportOptions: { backgroundColor: this.options.theme.panel },
      contentOptions: { backgroundColor: this.options.theme.panel },
    });
    scroll.add(new TextRenderable(renderer, {
      content,
      width: "100%",
      fg: this.options.theme.text,
      bg: this.options.theme.panel,
      wrapMode: "word",
    }));
    return scroll;
  }

  private backdropBox(renderer: CliRenderer): BoxRenderable {
    return new BoxRenderable(renderer, {
      id: `modal-backdrop-${this.nextModalId}`,
      position: "absolute",
      zIndex: 99,
      top: 0,
      left: 0,
      width: renderer.width,
      height: renderer.height,
      backgroundColor: RGBA.fromInts(0, 0, 0, 170),
    });
  }

  private button(renderer: CliRenderer, label: string, width: number): { box: BoxRenderable; label: TextRenderable } {
    const box = new BoxRenderable(renderer, {
      width,
      height: 3,
      border: true,
      borderStyle: "rounded",
      borderColor: this.options.theme.borderActive,
      backgroundColor: this.options.theme.element,
      alignItems: "center",
      justifyContent: "center",
    });
    const text = new TextRenderable(renderer, {
      content: label,
      width: Math.max(1, label.length),
      height: 1,
      fg: this.options.theme.text,
      bg: this.options.theme.element,
    });
    box.add(text);
    return { box, label: text };
  }

  private setButtonState(button: { box: BoxRenderable; label: TextRenderable }, active: boolean): void {
    button.box.borderStyle = active ? "heavy" : "rounded";
    button.box.borderColor = active ? this.options.theme.primary : this.options.theme.borderActive;
    button.box.backgroundColor = active ? this.options.theme.primary : this.options.theme.element;
    button.label.fg = active ? RGBA.fromHex(this.options.theme.selectedText) : RGBA.fromHex(this.options.theme.text);
    button.label.bg = active ? RGBA.fromHex(this.options.theme.primary) : RGBA.fromHex(this.options.theme.element);
  }

  private shortcutBar(renderer: CliRenderer, shortcuts: Shortcut[], marginTop = 0): TextRenderable {
    return new TextRenderable(renderer, {
      content: formatShortcuts(shortcuts, this.options.theme),
      width: "100%",
      height: 1,
      bg: this.options.theme.panel,
      marginTop,
    });
  }

  private closeModal(renderer: CliRenderer, modal: BoxRenderable, backdrop: BoxRenderable): void {
    renderer.root.remove(modal);
    renderer.root.remove(backdrop);
    modal.destroyRecursively();
    backdrop.destroyRecursively();
    renderer.root.requestRender();
  }

  private selectOptions(id: string, height: number): ConstructorParameters<typeof SelectRenderable>[1] {
    return {
      id,
      width: "100%",
      height,
      options: [],
      backgroundColor: this.options.theme.panel,
      focusedBackgroundColor: this.options.theme.panel,
      textColor: this.options.theme.text,
      focusedTextColor: this.options.theme.text,
      selectedBackgroundColor: this.options.theme.primary,
      selectedTextColor: this.options.theme.selectedText,
      descriptionColor: this.options.theme.muted,
      selectedDescriptionColor: this.options.theme.selectedText,
      showScrollIndicator: true,
      showSelectionIndicator: false,
      wrapSelection: true,
      itemSpacing: 0,
    };
  }
}

function maxModalHeight(renderer: CliRenderer): number {
  return Math.max(1, Math.min(renderer.height, Math.floor(renderer.height * 0.8)));
}

function modalInnerWidth(renderer: CliRenderer): number {
  return Math.max(1, modalWidth(renderer) - 4);
}

function modalWidth(renderer: CliRenderer): number {
  return Math.max(1, Math.min(72, renderer.width - 2));
}

function formatShortcuts(shortcuts: Shortcut[], theme: DialogTheme): StyledText {
  const chunks: StyledText["chunks"] = [];
  shortcuts.forEach((shortcut, index) => {
    if (index > 0) chunks.push({ __isChunk: true, text: "  " });
    chunks.push({
      __isChunk: true,
      text: ` ${shortcut.key} `,
      fg: RGBA.fromHex(theme.primary),
      bg: RGBA.fromHex(theme.element),
      attributes: TextAttributes.BOLD,
    });
    chunks.push({ __isChunk: true, text: ` ${shortcut.label}`, fg: RGBA.fromHex(theme.muted) });
  });
  return new StyledText(chunks);
}

function estimateWrappedRows(content: string, width: number): number {
  return content.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / width)), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function isCancelKey(key: KeyEvent): boolean {
  return key.name === "escape" || key.name === "esc" || key.raw === "\x1b" || key.sequence === "\x1b" || (key.ctrl && key.name === "c");
}

function isKey(key: KeyEvent, value: string): boolean {
  return key.name === value || key.sequence === value || key.raw === value;
}

function isSubmitKey(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n";
}

function consumeKey(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}
