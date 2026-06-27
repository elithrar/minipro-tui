import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
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
    const textHeight = clamp(estimateWrappedRows(content, modalInnerWidth(renderer)), 3, Math.max(3, maxHeight - 7));
    const modal = this.modalBox(renderer, textHeight + 6);
    this.addHeader(renderer, modal, title);
    modal.add(new TextRenderable(renderer, { content, width: "100%", height: textHeight, fg: this.options.theme.muted, bg: this.options.theme.panel, wrapMode: "word", marginBottom: 1 }));
    const buttonRow = new TextRenderable(renderer, { content: "", width: "100%", height: 1, fg: this.options.theme.text, bg: this.options.theme.panel, marginBottom: 1 });
    modal.add(buttonRow);
    modal.add(new TextRenderable(renderer, { content: "left/right choose  enter select  esc cancel", width: "100%", height: 1, fg: this.options.theme.muted, bg: this.options.theme.panel }));
    const backdrop = this.backdropBox(renderer);
    renderer.root.add(backdrop);
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        modal.onKeyDown = undefined;
        modal.blur();
        this.closeModal(renderer, modal, backdrop);
        this.options.onClose();
        resolve(value);
      };
      let active: "cancel" | "confirm" = "cancel";
      const renderButtons = () => {
        buttonRow.content = formatConfirmButtons(active, confirmLabel.toLowerCase(), modalInnerWidth(renderer));
        renderer.root.requestRender();
      };
      modal.onKeyDown = (key: KeyEvent) => {
        if (isCancelKey(key) || isKey(key, "q") || isKey(key, "n")) {
          key.preventDefault();
          key.stopPropagation();
          done(false);
          return;
        }
        if (isKey(key, "left")) {
          key.preventDefault();
          key.stopPropagation();
          active = "cancel";
          renderButtons();
          return;
        }
        if (isKey(key, "right")) {
          key.preventDefault();
          key.stopPropagation();
          active = "confirm";
          renderButtons();
          return;
        }
        if (key.name === "enter" || key.sequence === "\r" || key.sequence === "\n") {
          key.preventDefault();
          key.stopPropagation();
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
    const modal = this.modalBox(renderer, 8);
    this.addHeader(renderer, modal, title);
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
    modal.add(new TextRenderable(renderer, { content: "enter read  esc cancel", width: "100%", height: 1, fg: this.options.theme.muted, bg: this.options.theme.panel }));
    const backdrop = this.backdropBox(renderer);
    renderer.root.add(backdrop);
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      let settled = false;
      const done = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        input.onKeyDown = undefined;
        input.off(InputRenderableEvents.ENTER, submit);
        input.blur();
        this.closeModal(renderer, modal, backdrop);
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
    const modalHeight = clamp(desiredSelectHeight + 5, 8, maxModalHeight(renderer));
    const modal = this.modalBox(renderer, modalHeight);
    this.addHeader(renderer, modal, title);
    const select = new SelectRenderable(renderer, {
      ...this.selectOptions("modal-select", Math.max(4, modalHeight - 5)),
      options,
      selectedIndex: Math.max(0, selectedIndex),
    });
    modal.add(select);
    modal.add(new TextRenderable(renderer, { content: "enter select  arrows move  esc cancel", width: "100%", height: 1, fg: this.options.theme.muted, bg: this.options.theme.panel, marginTop: 1 }));
    const backdrop = this.backdropBox(renderer);
    renderer.root.add(backdrop);
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      let settled = false;
      const done = (value: SelectOption | undefined) => {
        if (settled) return;
        settled = true;
        select.onKeyDown = undefined;
        select.off(SelectRenderableEvents.ITEM_SELECTED, selected);
        select.blur();
        this.closeModal(renderer, modal, backdrop);
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
    const modal = this.modalBox(renderer, textHeight + 4);
    this.addHeader(renderer, modal, title);
    modal.add(new TextRenderable(renderer, { content, width: "100%", height: textHeight, fg: this.options.theme.muted, bg: this.options.theme.panel, wrapMode: "word", marginBottom: 1 }));
    modal.add(new TextRenderable(renderer, { content: "enter/esc close", width: "100%", height: 1, fg: this.options.theme.muted, bg: this.options.theme.panel, marginTop: 1 }));
    const backdrop = this.backdropBox(renderer);
    renderer.root.add(backdrop);
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        modal.onKeyDown = undefined;
        modal.blur();
        this.closeModal(renderer, modal, backdrop);
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

  private modalBox(renderer: CliRenderer, height: number): BoxRenderable {
    const modalHeight = clamp(height, 6, maxModalHeight(renderer));
    const width = modalWidth(renderer);
    return new BoxRenderable(renderer, {
      id: `modal-${++this.nextModalId}`,
      position: "absolute",
      zIndex: 100,
      top: Math.max(1, Math.floor(renderer.height / 4)),
      left: Math.max(1, Math.floor((renderer.width - width) / 2)),
      width,
      height: modalHeight,
      border: false,
      backgroundColor: this.options.theme.panel,
      padding: 1,
      flexDirection: "column",
    });
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
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
    });
  }

  private addHeader(renderer: CliRenderer, modal: BoxRenderable, title: string): void {
    const width = Math.max(10, modal.width - 2);
    const esc = "esc";
    const titleWidth = Math.max(1, width - esc.length - 1);
    const label = truncateEnd(title, titleWidth);
    const content = `${label}${" ".repeat(Math.max(1, width - label.length - esc.length))}${esc}`;
    modal.add(new TextRenderable(renderer, { content, width: "100%", height: 1, fg: this.options.theme.text, bg: this.options.theme.panel, marginBottom: 1 }));
  }

  private closeModal(renderer: CliRenderer, modal: BoxRenderable, backdrop: BoxRenderable): void {
    renderer.root.remove(modal.id);
    renderer.root.remove(backdrop.id);
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
      wrapSelection: true,
      itemSpacing: 0,
    };
  }
}

function maxModalHeight(renderer: CliRenderer): number {
  return Math.max(6, Math.floor(renderer.height * 0.6));
}

function modalInnerWidth(renderer: CliRenderer): number {
  return Math.max(20, modalWidth(renderer) - 2);
}

function modalWidth(renderer: CliRenderer): number {
  return clamp(60, 30, Math.max(30, renderer.width - 2));
}

function formatConfirmButtons(active: "cancel" | "confirm", confirmLabel: string, width: number): string {
  const cancel = active === "cancel" ? "[cancel]" : " cancel ";
  const confirm = active === "confirm" ? `[${confirmLabel}]` : ` ${confirmLabel} `;
  const content = `${cancel} ${confirm}`;
  return `${" ".repeat(Math.max(0, width - content.length))}${content}`;
}

function estimateWrappedRows(content: string, width: number): number {
  return content.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / width)), 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function truncateEnd(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 3) return ".".repeat(width);
  return `${value.slice(0, width - 3)}...`;
}

function isCancelKey(key: KeyEvent): boolean {
  return key.name === "escape" || key.name === "esc" || key.raw === "\x1b" || key.sequence === "\x1b" || (key.ctrl && key.name === "c");
}

function isKey(key: KeyEvent, value: string): boolean {
  return key.name === value || key.sequence === value || key.raw === value;
}
