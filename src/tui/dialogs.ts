import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
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

export class DialogController {
  private nextModalId = 0;

  constructor(private readonly options: DialogControllerOptions) {}

  async confirm(title: string, content: string, confirmLabel: string): Promise<boolean> {
    const renderer = this.options.getRenderer();
    this.options.onOpen();
    const maxHeight = maxModalHeight(renderer);
    const textHeight = clamp(estimateWrappedRows(content, modalInnerWidth(renderer)), 3, Math.max(3, maxHeight - 8));
    const modal = this.modalBox(renderer, title, textHeight + 8);
    modal.add(new TextRenderable(renderer, { content, width: "100%", height: textHeight, fg: this.options.theme.text, bg: this.options.theme.panel, wrapMode: "word", marginBottom: 1 }));
    const buttons = new SelectRenderable(renderer, {
      ...this.selectOptions("confirm-buttons", 4),
      options: [
        { name: "Cancel", description: "Return without continuing", value: "cancel" },
        { name: confirmLabel, description: "Continue with this action", value: "confirm" },
      ],
      selectedIndex: 0,
    });
    modal.add(buttons);
    modal.add(new TextRenderable(renderer, { content: "Enter = Choose    Esc/q = Cancel", width: "100%", height: 1, fg: this.options.theme.muted, bg: this.options.theme.panel, marginTop: 1 }));
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        buttons.onKeyDown = undefined;
        buttons.off(SelectRenderableEvents.ITEM_SELECTED, selected);
        renderer.root.remove(modal.id);
        this.options.onClose();
        resolve(value);
      };
      const selected = (_index: number, option: SelectOption) => done(option.value === "confirm");
      buttons.on(SelectRenderableEvents.ITEM_SELECTED, selected);
      buttons.onKeyDown = (key: KeyEvent) => {
        if (isCancelKey(key) || isKey(key, "q") || isKey(key, "n")) {
          key.preventDefault();
          key.stopPropagation();
          done(false);
        }
      };
      buttons.focus();
    });
  }

  async filename(title: string, initialValue: string): Promise<string | undefined> {
    const renderer = this.options.getRenderer();
    this.options.onOpen();
    const modal = this.modalBox(renderer, title, 9);
    modal.add(new TextRenderable(renderer, { content: "Output filename:", width: "100%", height: 1, fg: this.options.theme.muted, bg: this.options.theme.panel }));
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
    modal.add(new TextRenderable(renderer, { content: "Enter = Read    Esc = Cancel", width: "100%", height: 1, fg: this.options.theme.muted, bg: this.options.theme.panel }));
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      let settled = false;
      const done = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        input.onKeyDown = undefined;
        input.off(InputRenderableEvents.ENTER, submit);
        renderer.root.remove(modal.id);
        this.options.onClose();
        resolve(value);
      };
      const submit = (value: string) => done(value.trim() || undefined);
      input.on(InputRenderableEvents.ENTER, submit);
      input.onKeyDown = (key: KeyEvent) => {
        if (isCancelKey(key)) {
          key.preventDefault();
          key.stopPropagation();
          done(undefined);
        }
      };
      setTimeout(() => {
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
    modal.add(new TextRenderable(renderer, { content: "Enter = Select    Esc/q = Cancel", width: "100%", height: 1, fg: this.options.theme.muted, bg: this.options.theme.panel, marginTop: 1 }));
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      let settled = false;
      const done = (value: SelectOption | undefined) => {
        if (settled) return;
        settled = true;
        select.onKeyDown = undefined;
        select.off(SelectRenderableEvents.ITEM_SELECTED, selected);
        renderer.root.remove(modal.id);
        this.options.onClose();
        resolve(value);
      };
      const selected = (_index: number, option: SelectOption) => done(option);
      select.on(SelectRenderableEvents.ITEM_SELECTED, selected);
      select.onKeyDown = (key: KeyEvent) => {
        if (isCancelKey(key) || isKey(key, "q")) {
          key.preventDefault();
          key.stopPropagation();
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
    const textHeight = clamp(estimateWrappedRows(content, modalInnerWidth(renderer)), 3, Math.max(3, maxHeight - 5));
    const modal = this.modalBox(renderer, title, textHeight + 5);
    modal.add(new TextRenderable(renderer, { content, width: "100%", height: textHeight, fg: this.options.theme.text, bg: this.options.theme.panel, wrapMode: "word", marginBottom: 1 }));
    modal.add(new TextRenderable(renderer, { content: "Enter/Esc/q = Close", width: "100%", height: 1, fg: this.options.theme.muted, bg: this.options.theme.panel, marginTop: 1 }));
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        modal.onKeyDown = undefined;
        renderer.root.remove(modal.id);
        this.options.onClose();
        resolve();
      };
      modal.onKeyDown = (key: KeyEvent) => {
        if (isCancelKey(key) || isKey(key, "q") || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n") {
          key.preventDefault();
          key.stopPropagation();
          done();
        }
      };
      modal.focusable = true;
      modal.focus();
    });
  }

  private modalBox(renderer: CliRenderer, title: string, height: number): BoxRenderable {
    const modalHeight = clamp(height, 6, maxModalHeight(renderer));
    return new BoxRenderable(renderer, {
      id: `modal-${++this.nextModalId}`,
      title: ` ${title} `,
      titleColor: this.options.theme.primary,
      position: "absolute",
      zIndex: 100,
      top: Math.max(1, Math.floor((renderer.height - modalHeight) / 2)),
      left: "5%",
      width: "90%",
      height: modalHeight,
      border: true,
      borderStyle: "single",
      borderColor: this.options.theme.borderActive,
      focusedBorderColor: this.options.theme.primary,
      backgroundColor: this.options.theme.panel,
      padding: 1,
      flexDirection: "column",
    });
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
      wrapSelection: true,
    };
  }
}

function maxModalHeight(renderer: CliRenderer): number {
  return Math.max(6, renderer.height - 4);
}

function modalInnerWidth(renderer: CliRenderer): number {
  return Math.max(20, Math.floor(renderer.width * 0.9) - 4);
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
