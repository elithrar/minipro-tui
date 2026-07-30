import { readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import {
  BoxRenderable,
  CliRenderEvents,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  RenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type SelectOption,
} from "@opentui/core";

import { createBadge } from "./components/ui/badge";
import { createInput } from "./components/ui/input";
import type { AdvancedOptions, ChipInfo, FileEntry, FileTreeEntry, JobState, ProgrammerKind, ProgrammerStatus } from "./types";
import { sha256Bytes } from "./files/hash";
import { MAX_IMAGE_FILE_BYTES, normalizeImageBytes } from "./files/image";
import { isFileEntry, scanFileTree } from "./files/scan";
import type { ProgrammerBackend, ReadOptions } from "./xgecu/backend";
import { captureDestination, runCompareWorkflow, runDefaultWriteWorkflow, runReadWorkflow, type DestinationSnapshot } from "./xgecu/workflow";
import { DEFAULT_ADVANCED_OPTIONS, dangerousOptionWarnings } from "./safety/options";
import { loadState, saveState, type PersistedState } from "./state";
import { DialogController } from "./tui/dialogs";
import { formatChipInfo, formatChipLabel, formatFileTreeOption, formatGuidanceLine, formatLogContent, formatStatusLine, formatStatusSummaryContent, sanitizeLogLine } from "./tui/render";
import { formatKeyHints, type KeyHint, tuiTheme } from "./tui/theme";

const PRIMARY = tuiTheme.primary;
const BG = tuiTheme.background;
const PANEL = tuiTheme.panel;
const ELEMENT = tuiTheme.element;
const ELEMENT_FOCUSED = tuiTheme.elementFocused;
const BORDER = tuiTheme.border;
const BORDER_ACTIVE = tuiTheme.borderActive;
const TEXT = tuiTheme.text;
const SELECTED_TEXT = tuiTheme.selectedText;
const MUTED = tuiTheme.muted;
const DEFAULT_DATABASE: ProgrammerKind = "t48";
const DEFAULT_CHIP_QUERY = "AT28C64B";
const SECONDARY_DEFAULT_CHIP = "M27C64A@DIP28";
const RECENT_LIMIT = 8;
const LOG_LINE_LIMIT = 2000;
const COMPACT_WIDTH = 90;
const COMPACT_HEIGHT = 28;

type CompactPanel = "files" | "chips" | "status" | "log";
type Notice = { tone: "info" | "error"; message: string };
type ChipSearchState = { requestId: number; query: string; phase: "results" | "details" };

export type ChipDeskAppOptions = {
  renderer?: CliRenderer;
  backend?: ProgrammerBackend;
  backendFactory?: () => Promise<ProgrammerBackend>;
  persistence?: boolean;
  exit?: (code: number) => void;
};

type Components = {
  main: BoxRenderable;
  topRow: BoxRenderable;
  compactTabs: TabSelectRenderable;
  compactContent: BoxRenderable;
  statusBarBox: BoxRenderable;
  brandBadge: BoxRenderable;
  compactBrandBadge: BoxRenderable;
  buildLabel: TextRenderable;
  statusChrome: TextRenderable;
  guidanceChrome: TextRenderable;
  connectedBadge: BoxRenderable;
  disconnectedBadge: BoxRenderable;
  t48Badge: BoxRenderable;
  t56Badge: BoxRenderable;
  t76Badge: BoxRenderable;
  filesPanel: BoxRenderable;
  fileSearchBox: BoxRenderable;
  fileQuery: InputRenderable;
  files: SelectRenderable;
  chipPanel: BoxRenderable;
  chipSearchBox: BoxRenderable;
  chipQuery: InputRenderable;
  chips: SelectRenderable;
  statusPanel: BoxRenderable;
  statusSummary: TextRenderable;
  logPanel: BoxRenderable;
  log: ScrollBoxRenderable;
  logText: TextRenderable;
  footerBox: BoxRenderable;
  footerText: TextRenderable;
};

export class ChipDeskApp {
  private renderer: CliRenderer | undefined;
  private components: Components | undefined;
  private backend: ProgrammerBackend | undefined;
  private programmerStatus: ProgrammerStatus = { connected: false, raw: "" };
  private database: ProgrammerKind = DEFAULT_DATABASE;
  private fileTreeEntries: FileTreeEntry[] = [];
  private files: FileEntry[] = [];
  private fileDirectory = process.cwd();
  private fileQuery = "";
  private chipQuery = DEFAULT_CHIP_QUERY;
  private chipResults: string[] = [];
  private chipInfoCache = new Map<string, ChipInfo>();
  private recentFilePaths: string[] = [];
  private recentDirectories: string[] = [];
  private recentChips: string[] = [];
  private recentDatabases: ProgrammerKind[] = [];
  private selectedFile: FileEntry | undefined;
  private selectedChip: string | undefined;
  private chipInfo: ChipInfo | undefined;
  private job: JobState = { kind: "idle" };
  private logLines: string[] = [];
  private showAllFiles = false;
  private advanced: AdvancedOptions = { ...DEFAULT_ADVANCED_OPTIONS };
  private modalActive = false;
  private restoreFocusAfterModal: (() => void) | undefined;
  private chipSearchRequestId = 0;
  private chipInfoRequestId = 0;
  private chipSearchAbortController: AbortController | undefined;
  private fileOptionsKey = "";
  private chipOptionsKey = "";
  private statusLine = "";
  private guidanceLine = "";
  private notice: Notice | undefined;
  private chipSearch: ChipSearchState | undefined;
  private activeAbortController: AbortController | undefined;
  private activeCommandCancellable = false;
  private operationPending = false;
  private compactMode = false;
  private compactPanel: CompactPanel = "files";
  private modalOriginPanel: CompactPanel | undefined;
  private shuttingDown = false;
  private stateSave: Promise<void> = Promise.resolve();
  private readonly options: ChipDeskAppOptions;
  private readonly dialogs = new DialogController({
    getRenderer: () => this.requireRenderer(),
    theme: {
      primary: PRIMARY,
      panel: PANEL,
      element: ELEMENT,
      elementFocused: ELEMENT_FOCUSED,
      borderActive: BORDER_ACTIVE,
      text: TEXT,
      selectedText: SELECTED_TEXT,
      muted: MUTED,
    },
    onOpen: () => {
      const focus = this.focusLabel();
      this.modalOriginPanel = focus === "Chip Search" || focus === "Chip Results" ? "chips" : focus === "Log" ? "log" : focus === "File Search" || focus === "Files" ? "files" : this.compactPanel;
      this.restoreFocusAfterModal = this.captureFocusedControl();
      this.modalActive = true;
    },
    onClose: () => {
      this.modalActive = false;
      this.restoreFocusAfterModal?.();
      this.restoreFocusAfterModal = undefined;
      this.modalOriginPanel = undefined;
      this.render();
    },
  });

  constructor(options: ChipDeskAppOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    const saved = this.options.persistence === false ? undefined : await loadState();
    if (saved) this.restoreState(saved);
    this.renderer = this.options.renderer ?? await createCliRenderer({
      exitOnCtrlC: false,
      consoleMode: "disabled",
      backgroundColor: BG,
    });
    this.backend = this.options.backend ?? await (this.options.backendFactory ?? createDefaultBackend)();
    this.components = this.createLayout(this.renderer);
    this.bindKeys(this.renderer, this.components);
    this.applyResponsiveLayout();
    this.renderer.on(CliRenderEvents.RESIZE, () => {
      this.applyResponsiveLayout();
      setTimeout(() => this.render(), 0);
    });
    this.render();
    await this.refresh();
    await this.searchChip(DEFAULT_CHIP_QUERY, true);
  }

  private createLayout(renderer: CliRenderer): Components {
    const root = new BoxRenderable(renderer, {
      id: "root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: BG,
    });

    const statusBarBox = new BoxRenderable(renderer, {
      id: "status-bar-box",
      width: "100%",
      height: 4,
      flexDirection: "column",
      backgroundColor: PANEL,
      border: ["bottom"],
      borderStyle: "single",
      borderColor: BORDER,
    });
    const metaRow = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: PANEL,
      paddingLeft: 1,
      paddingRight: 1,
    });
    const brandBadge = createBadge(renderer, {
      id: "brand-badge",
      label: "CHIPDESK // EEPROM WORKBENCH",
      intent: "neutral",
      height: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: PANEL,
    });
    const compactBrandBadge = createBadge(renderer, {
      label: "CHIPDESK",
      intent: "neutral",
      height: 1,
      backgroundColor: PANEL,
      visible: false,
    });
    const buildLabel = new TextRenderable(renderer, {
      content: "DIRECT USB  //  SAFE WRITE FLOW",
      width: 31,
      height: 1,
      fg: MUTED,
      bg: PANEL,
    });
    metaRow.add(brandBadge);
    metaRow.add(compactBrandBadge);
    metaRow.add(new BoxRenderable(renderer, { flexGrow: 1, height: 1, backgroundColor: PANEL }));
    metaRow.add(buildLabel);

    const contextRow = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: PANEL,
      paddingLeft: 1,
      paddingRight: 1,
      columnGap: 1,
    });
    const connectedBadge = createBadge(renderer, { label: "USB ONLINE", intent: "success", height: 1 });
    const disconnectedBadge = createBadge(renderer, { label: "USB OFFLINE", intent: "danger", height: 1 });
    const t48Badge = createBadge(renderer, { label: "T48 CATALOG", intent: "warning", height: 1 });
    const t56Badge = createBadge(renderer, { label: "T56 CATALOG", intent: "warning", height: 1 });
    const t76Badge = createBadge(renderer, { label: "T76 CATALOG", intent: "warning", height: 1 });
    const statusChrome = new TextRenderable(renderer, {
      id: "status-chrome",
      flexGrow: 1,
      height: 1,
      fg: TEXT,
      bg: PANEL,
      wrapMode: "none",
    });
    contextRow.add(connectedBadge);
    contextRow.add(disconnectedBadge);
    contextRow.add(t48Badge);
    contextRow.add(t56Badge);
    contextRow.add(t76Badge);
    contextRow.add(statusChrome);
    const guidanceChrome = new TextRenderable(renderer, {
      id: "guidance-chrome",
      width: "100%",
      height: 1,
      fg: MUTED,
      bg: PANEL,
      wrapMode: "none",
      paddingLeft: 1,
      paddingRight: 1,
    });
    statusBarBox.add(metaRow);
    statusBarBox.add(contextRow);
    statusBarBox.add(guidanceChrome);

    const main = new BoxRenderable(renderer, {
      id: "main",
      flexGrow: 1,
      width: "100%",
      flexDirection: "column",
      paddingTop: 1,
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: BG,
      onMouseDown: (event) => this.handleWorkbenchPointerDown(event.x, event.y),
    });

    const compactTabs = new TabSelectRenderable(renderer, {
      id: "compact-tabs",
      width: "100%",
      height: 1,
      tabWidth: 10,
      options: [
        { name: "Image", description: "Browse images", value: "files" },
        { name: "Device", description: "Search devices", value: "chips" },
        { name: "Safety", description: "Review safety", value: "status" },
        { name: "Trace", description: "Command output", value: "log" },
      ],
      showDescription: false,
      showUnderline: false,
      wrapSelection: true,
      backgroundColor: BG,
      focusedBackgroundColor: BG,
      selectedBackgroundColor: PRIMARY,
      selectedTextColor: SELECTED_TEXT,
      onMouseDown: (event) => this.handleCompactTabPointerDown(event),
    });
    const compactContent = new BoxRenderable(renderer, {
      id: "compact-content",
      width: "100%",
      flexGrow: 1,
      backgroundColor: BG,
      flexDirection: "column",
    });

    const topRow = new BoxRenderable(renderer, { id: "top-row", height: 15, width: "100%", flexDirection: "row", marginBottom: 1 });
    const filesPanel = panel(renderer, "files-panel", "01 IMAGE // .");
    filesPanel.flexGrow = 1.2;
    filesPanel.marginRight = 1;
    const fileSearchBox = searchBox(renderer, "file-search-box");
    const fileQuery = createInput(renderer, {
      id: "file-query",
      value: "",
      placeholder: "Find files or folders",
      width: "100%",
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      textColor: TEXT,
      cursorColor: PRIMARY,
    });
    fileQuery.onKeyDown = (key) => {
      if (isEscapeKey(key)) {
        consumeKey(key);
        this.exitSearchInput();
      }
    };
    const files = new SelectRenderable(renderer, selectOptions("files", "100%"));
    fileSearchBox.add(fileQuery);
    filesPanel.add(fileSearchBox);
    filesPanel.add(files);

    const chipPanel = panel(renderer, "chip-panel", "02 DEVICE CATALOG");
    chipPanel.flexGrow = 0.9;
    chipPanel.marginRight = 1;
    const chipSearchBox = searchBox(renderer, "chip-search-box");
    const chipQuery = createInput(renderer, {
      id: "chip-query",
      value: DEFAULT_CHIP_QUERY,
      placeholder: "AT28C64B",
      width: "100%",
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      textColor: TEXT,
      cursorColor: PRIMARY,
    });
    chipQuery.onKeyDown = (key) => {
      if (isEscapeKey(key)) {
        consumeKey(key);
        this.exitSearchInput();
      }
    };
    const chips = new SelectRenderable(renderer, {
      ...selectOptions("chips", "100%"),
      showDescription: true,
      selectedDescriptionColor: BORDER,
      itemSpacing: 0,
    });
    chipSearchBox.add(chipQuery);
    chipPanel.add(chipSearchBox);
    chipPanel.add(chips);

    const statusPanel = panel(renderer, "status-panel", "03 WRITE RECEIPT");
    statusPanel.flexGrow = 1.1;
    statusPanel.width = "100%";
    const statusSummary = new TextRenderable(renderer, {
      id: "status-summary",
      width: "100%",
      height: "100%",
      fg: TEXT,
      bg: PANEL,
      wrapMode: "none",
      truncate: false,
    });
    statusPanel.add(statusSummary);

    const logPanel = panel(renderer, "log-panel", "04 OPERATION TRACE");
    logPanel.flexGrow = 1;
    logPanel.width = "100%";
    const log = new ScrollBoxRenderable(renderer, {
      id: "log",
      width: "100%",
      height: "100%",
      stickyScroll: true,
      stickyStart: "bottom",
      rootOptions: { backgroundColor: PANEL },
      viewportOptions: { backgroundColor: PANEL },
      contentOptions: { backgroundColor: PANEL },
    });
    const logText = new TextRenderable(renderer, { id: "log-text", width: "100%", fg: TEXT, bg: PANEL, wrapMode: "word" });
    log.add(logText);
    logPanel.add(log);

    const footerBox = new BoxRenderable(renderer, {
      id: "footer",
      width: "100%",
      height: 2,
      border: ["top"],
      borderStyle: "single",
      borderColor: BORDER,
      backgroundColor: BG,
      paddingLeft: 1,
      paddingRight: 1,
      alignItems: "center",
    });
    const footerText = new TextRenderable(renderer, {
      id: "footer-text",
      width: "100%",
      height: 1,
      bg: BG,
    });
    footerBox.add(footerText);

    topRow.add(filesPanel);
    topRow.add(chipPanel);
    topRow.add(statusPanel);
    main.add(topRow);
    main.add(logPanel);
    main.add(footerBox);
    root.add(statusBarBox);
    root.add(main);
    renderer.root.add(root);
    files.focus();

    return {
      main, topRow, compactTabs, compactContent, statusBarBox, brandBadge, compactBrandBadge, buildLabel, statusChrome, guidanceChrome,
      connectedBadge, disconnectedBadge, t48Badge, t56Badge, t76Badge,
      filesPanel, fileSearchBox, fileQuery, files,
      chipPanel, chipSearchBox, chipQuery, chips,
      statusPanel, statusSummary, logPanel, log, logText, footerBox, footerText,
    };
  }

  private bindKeys(renderer: CliRenderer, components: Components): void {
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (this.modalActive) return;

      if (key.ctrl && key.name === "c") {
        void this.quit();
        return;
      }

      if ((key.name === "escape" || key.name === "esc") && this.job.kind === "running" && this.activeCommandCancellable) {
        consumeKey(key);
        this.appendLog(`Cancelling ${this.job.step}.`);
        this.activeAbortController?.abort();
        return;
      }

      if (this.operationPending) {
        consumeKey(key);
        return;
      }

      if (components.fileQuery.focused || components.chipQuery.focused) {
        if (isEscapeKey(key)) {
          consumeKey(key);
          this.exitSearchInput();
          return;
        }
        if (key.name === "tab") {
          consumeKey(key);
          this.focusNext(key.shift);
        }
        return;
      }

      if (key.name === "q") {
        consumeKey(key);
        void this.quit();
        return;
      }

      if (key.name === "tab") {
        consumeKey(key);
        this.focusNext(key.shift);
        return;
      }

      if (key.name === "/" || key.sequence === "/") {
        consumeKey(key);
        this.showCompactPanel("chips");
        components.chipQuery.focus();
        this.render();
        return;
      }

      if (key.name === "f") {
        consumeKey(key);
        this.showCompactPanel("files");
        components.fileQuery.focus();
        this.render();
        return;
      }

      if (components.files.focused && key.name === "backspace") {
        void this.openFileDirectory("..");
        return;
      }

      if (components.files.focused && (key.name === "space" || key.sequence === " ")) {
        const option = components.files.getSelectedOption();
        if (option) void this.selectFileTreeEntry(String(option.value ?? ""), true);
        return;
      }

      if (key.name === "r" && (key.shift || key.sequence === "R")) {
        this.startOperation(() => this.readFlow());
        return;
      }

      switch (key.name) {
        case "r":
          this.startOperation(() => this.refresh());
          break;
        case "p":
          void this.pickProgrammerDatabase();
          break;
        case "c":
          this.startOperation(() => this.pinCheck());
          break;
        case "b":
          this.startOperation(() => this.blankCheck());
          break;
        case "v":
          this.startOperation(() => this.verifySelectedFile());
          break;
        case "m":
          this.startOperation(() => this.compareFlow());
          break;
        case "w":
          this.startOperation(() => this.writeFlow());
          break;
        case "a":
          void this.advancedModal();
          break;
        case "l":
          this.showCompactPanel("log");
          components.log.focus();
          this.render();
          break;
        case "i":
          void this.showChipInfo();
          break;
        case "?":
          void this.help();
          break;
      }
    });

    components.chipQuery.on(InputRenderableEvents.ENTER, (value: string) => {
      void this.searchChip(value.trim() || DEFAULT_CHIP_QUERY, false, true);
    });

    components.fileQuery.on(InputRenderableEvents.INPUT, (value: string) => {
      this.fileQuery = value;
      this.render();
    });

    components.fileQuery.on(InputRenderableEvents.ENTER, (value: string) => {
      this.fileQuery = value;
      components.files.focus();
      this.render();
    });

    components.files.on(SelectRenderableEvents.SELECTION_CHANGED, (_index: number, option: SelectOption | null) => {
      this.selectFileTreeEntry(String(option?.value ?? ""));
    });

    components.files.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
      void this.selectFileTreeEntry(String(option.value ?? ""), true);
    });

    components.chips.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
      void this.selectChip(String(option.value ?? option.name));
    });

    components.compactTabs.on(TabSelectRenderableEvents.SELECTION_CHANGED, (_index: number, option) => {
      if (isCompactPanel(option.value)) this.setCompactPanel(option.value);
    });

    for (const focusable of [components.compactTabs, components.fileQuery, components.files, components.chipQuery, components.chips, components.log]) {
      focusable.on(RenderableEvents.FOCUSED, () => this.render());
      focusable.on(RenderableEvents.BLURRED, () => this.render());
    }
  }

  private async refresh(): Promise<void> {
    if (this.job.kind === "running") return;
    this.appendLog("Refreshing files and programmer status.");
    this.setJob({ kind: "running", step: "refresh" });
    try {
      await this.refreshFiles();

      this.programmerStatus = await this.requireBackend().getStatus();
      if (this.programmerStatus.kind && this.programmerStatus.kind !== this.database) {
        this.database = this.programmerStatus.kind;
        this.chipInfoCache.clear();
        this.selectedChip = undefined;
        this.chipInfo = undefined;
      }
      this.setJob({ kind: "idle" });
    } catch (error) {
      this.setJob({ kind: "failed", step: "refresh", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async refreshFiles(): Promise<void> {
    this.fileTreeEntries = await scanFileTree(this.fileDirectory, this.showAllFiles);
    this.files = this.fileTreeEntries.filter(isFileEntry);
    const selectedPath = this.selectedFile?.path;
    this.selectedFile = selectedPath ? this.files.find((entry) => entry.path === selectedPath) : undefined;
    if (!this.selectedFile && this.files.length > 0) this.selectedFile = this.files[0];
  }

  private async searchChip(query: string, preferDefault: boolean, focusResults = false): Promise<void> {
    if (this.job.kind === "running") return;
    this.chipSearchAbortController?.abort();
    const controller = new AbortController();
    this.chipSearchAbortController = controller;
    const requestId = ++this.chipSearchRequestId;
    const database = this.database;
    this.chipQuery = query;
    this.clearFeedback();
    this.chipResults = [];
    this.selectedChip = undefined;
    this.chipInfo = undefined;
    this.chipInfoRequestId++;
    this.chipSearch = { requestId, query, phase: "results" };
    const components = this.requireComponents();
    components.chipQuery.value = query;
    this.appendLog(`Searching ${database} database for ${query}.`);
    this.render();
    try {
      const devices = this.requireBackend().listDevices(query, database);
      if (!this.isCurrentChipSearch(requestId, database, query)) return;
      for (const info of devices) this.chipInfoCache.set(info.name, info);
      this.chipResults = orderChipResults(devices.map((device) => device.name), query);
      for (const chip of this.chipResults) {
        if (this.chipInfoCache.has(chip)) continue;
        const info = this.requireBackend().resolveDevice(chip, database);
        if (info) this.chipInfoCache.set(chip, info);
      }
      this.chipResults = this.chipResults.filter((chip) => this.chipInfoCache.has(chip));
      this.chipSearch = { requestId, query, phase: "details" };
      if (focusResults) components.chips.focus();
      this.render();

      const defaultChip = preferDefault && !this.selectedChip
        ? this.chipResults.find((chip) => chip === DEFAULT_CHIP_QUERY || chip.startsWith(`${DEFAULT_CHIP_QUERY}@`))
        : undefined;
      if (defaultChip) await this.selectChip(defaultChip);
    } finally {
      if (this.chipSearch?.requestId === requestId) {
        this.chipSearch = undefined;
        this.render();
      }
      if (this.chipSearchAbortController === controller) this.chipSearchAbortController = undefined;
    }
  }

  private isCurrentChipSearch(requestId: number, database: ProgrammerKind, query: string): boolean {
    return requestId === this.chipSearchRequestId && this.database === database && this.chipQuery === query;
  }

  private async selectFileTreeEntry(path: string, logSelection = false): Promise<void> {
    const entry = this.fileTreeEntries.find((item) => item.path === path);
    if (!entry) return;
    if (entry.kind === "directory") {
      if (logSelection) await this.openFileDirectory(entry.path);
      return;
    }

    const file = entry;
    const changed = this.selectedFile?.path !== file.path;
    if (changed) this.clearFeedback();
    this.selectedFile = file;
    if (logSelection) {
      this.recentFilePaths = rememberRecent(this.recentFilePaths, file.path);
      this.queueStateSave();
      this.appendLog(`Selected file ${file.name} (${file.size} B, ${file.sha256Short}).`);
    } else if (changed) this.render();
  }

  private async openFileDirectory(path: string): Promise<void> {
    this.clearFeedback();
    this.fileDirectory = path === ".." ? resolve(this.fileDirectory, "..") : path;
    this.recentDirectories = rememberRecent(this.recentDirectories, this.fileDirectory);
    this.queueStateSave();
    this.fileQuery = "";
    this.requireComponents().fileQuery.value = "";
    this.appendLog(`Browsing files in ${this.fileDirectory}.`);
    await this.refreshFiles();
    this.render();
  }

  private async selectChip(chip: string): Promise<void> {
    if (!chip || this.job.kind === "running") return;
    this.clearFeedback();
    const cached = this.chipInfoCache.get(chip);
    if (cached) {
      this.selectedChip = chip;
      this.chipInfo = cached;
      this.recentChips = rememberRecent(this.recentChips, chip);
      this.queueStateSave();
      this.appendLog(`Selected chip ${chip}.`);
      return;
    }

    const requestId = ++this.chipInfoRequestId;
    const database = this.database;
    this.selectedChip = chip;
    this.chipInfo = undefined;
    this.recentChips = rememberRecent(this.recentChips, chip);
    this.queueStateSave();
    this.appendLog(`Loading chip info for ${chip}.`);
    this.render();
    const info = this.requireBackend().resolveDevice(chip, database);
    if (requestId !== this.chipInfoRequestId || this.database !== database || this.selectedChip !== chip) return;
    if (!info) {
      this.appendLog(`Could not load chip info for ${chip}.`);
      this.chipInfo = undefined;
      this.render();
      return;
    }
    this.chipInfo = info;
    this.chipInfoCache.set(chip, info);
    this.render();
  }

  private async pickProgrammerDatabase(): Promise<void> {
    if (this.job.kind === "running") return;
    const kinds: ProgrammerKind[] = ["t48", "t56", "t76"];
    const orderedKinds = orderByRecents(kinds, this.recentDatabases);
    const choice = await this.dialogs.select(
      "Programmer Database",
      orderedKinds.map((kind) => ({ name: formatCurrentName(kind, kind === this.database), description: formatRecentDescription(this.recentDatabases.includes(kind), kind === this.database), value: kind })),
      orderedKinds.indexOf(this.database),
    );
    if (!choice || !isProgrammerKind(String(choice.value))) return;
    this.database = choice.value;
    this.recentDatabases = rememberRecent(this.recentDatabases, this.database);
    this.queueStateSave();
    this.chipInfoCache.clear();
    this.selectedChip = undefined;
    this.chipInfo = undefined;
    this.appendLog(`Selected programmer database ${this.database}.`);
    await this.searchChip(this.chipQuery || DEFAULT_CHIP_QUERY, true);
  }

  private async pinCheck(): Promise<void> {
    if (!this.selectedChip || !this.chipInfo) return this.showNotice("Select a chip before running pin/contact check.", "error");
    if (!this.chipInfo.supportsPinCheck || this.database !== "t48") return this.showNotice("Pin/contact check is unavailable for this chip and programmer.", "error");
    await this.runConnectedAction("pin/contact check", (options) => this.requireBackend().checkPinContacts(options).then((result) => {
      if (!result.passed) throw new Error(`Pin/contact check failed on pin${result.badPins.length === 1 ? "" : "s"} ${result.badPins.join(", ")}.`);
    }));
  }

  private async blankCheck(): Promise<void> {
    if (!this.selectedChip || !this.chipInfo) return this.showNotice("Select a chip before running blank check.", "error");
    const info = this.chipInfo;
    await this.runConnectedAction("blank check", async (options) => {
      const bytes = await this.requireBackend().readROM(options);
      const firstNonblank = bytes.findIndex((byte) => byte !== (info.blankValue ?? 0xff));
      if (firstNonblank !== -1) throw new Error(`Blank check failed at offset ${firstNonblank}.`);
    });
  }

  private async verifySelectedFile(): Promise<void> {
    if (this.job.kind === "running") return;
    if (!this.selectedFile) {
      this.showNotice("Select an image before verifying.", "error");
      return;
    }
    if (!this.selectedChip) {
      this.showNotice("Select a chip before verifying.", "error");
      return;
    }
    const frozen = await freezeFileForOperation(this.selectedFile.path);
    if (!frozen.ok) {
      this.showNotice(frozen.message, "error");
      return;
    }

    this.appendLog(`Verifying confirmed bytes: ${frozen.bytes.byteLength} B sha256 ${frozen.sha256}.`);
    await this.runConnectedAction("verify", async (options) => {
      const readback = await this.requireBackend().readROM(options);
      if (!bytesEqual(frozen.bytes, readback)) throw new Error(`Verify failed. Image sha256 ${frozen.sha256}, chip sha256 ${sha256Bytes(readback)}.`);
    });
  }

  private async runConnectedAction(step: string, action: (options: ReadOptions) => Promise<void>): Promise<void> {
    this.setJob({ kind: "running", step });
    try {
      await this.runBackendAction(true, (signal) => action(this.readOptions(signal)));
      this.setJob({ kind: "done", message: `${step} completed.` });
    } catch (error) {
      this.setJob({ kind: "failed", step, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async runBackendAction<T>(cancellable: boolean, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.activeCommandCancellable = cancellable;
    this.render();
    try {
      return await action(controller.signal);
    } finally {
      if (this.activeAbortController === controller) {
        this.activeAbortController = undefined;
        this.activeCommandCancellable = false;
        this.render();
      }
    }
  }

  private async writeFlow(): Promise<void> {
    if (this.job.kind === "running") return;
    if (!this.selectedFile) {
      this.showNotice("Select an image before writing.", "error");
      return;
    }
    if (!this.selectedChip) {
      this.showNotice("Select a chip before writing.", "error");
      return;
    }
    if (!this.chipInfo) {
      this.showNotice("Wait for chip details before writing.", "error");
      return;
    }
    const selectedFile = this.selectedFile;
    const selectedChip = this.selectedChip;
    const chipInfo = { ...this.chipInfo };
    const database = this.database;
    const advanced = { ...this.advanced };
    const fileDirectory = this.fileDirectory;

    let backupFile: string | undefined;
    let backupDestinationSnapshot: DestinationSnapshot | undefined;
    if (advanced.backupBeforeWrite) {
      backupFile = await this.dialogs.filename("Pre-write Backup", join(fileDirectory, defaultBackupFilename(selectedChip)));
      if (!backupFile) {
        this.appendLog("Write flow cancelled before choosing a backup filename.");
        return;
      }
      try {
        backupDestinationSnapshot = await captureDestination(backupFile);
      } catch (error) {
        this.showNotice(`Cannot inspect backup destination: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (backupDestinationSnapshot.exists) {
        await this.dialogs.message("Backup File Exists", "Choose a new backup filename. Existing files are never replaced by a hardware read.");
        this.appendLog("Write flow cancelled to preserve the existing backup file.");
        return;
      }
    }

    const frozen = await freezeFileForOperation(selectedFile.path);
    if (!frozen.ok) {
      this.showNotice(frozen.message, "error");
      return;
    }

    const preview = formatWritePreview(chipInfo, advanced, Boolean(backupFile));
    const confirmed = await this.dialogs.confirm(
      "Write Chip",
      [
        `${formatWriteActionSummary(advanced, Boolean(backupFile))} ${basename(selectedFile.path)} to ${selectedChip}.`,
        `Confirmed bytes: ${frozen.bytes.byteLength} B sha256 ${frozen.sha256}`,
        "",
        preview,
        "",
        ...dangerousOptionWarnings(advanced),
      ].join("\n"),
      "Write",
    );
    if (!confirmed) {
      this.appendLog("Write flow cancelled.");
      return;
    }

    this.setJob({ kind: "running", step: "write flow" });
    const result = await this.runBackendAction(true, (signal) => runDefaultWriteWorkflow({
      backend: this.requireBackend(), file: selectedFile, chip: selectedChip, chipInfo, programmerKind: database,
      confirmed: true, confirmedBytes: frozen.bytes, confirmedSha256: frozen.sha256,
      backupFile, backupDestinationSnapshot, advanced, signal,
      onStep: (step, cancellable) => {
        this.setJob({ kind: "running", step });
        this.activeCommandCancellable = cancellable;
        this.render();
      },
      onLog: (line) => this.appendLog(line),
    })).catch((error) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error), steps: [] }));

    this.appendLog(result.message);
    this.setJob(result.ok ? { kind: "done", message: result.message } : { kind: "failed", step: "write flow", message: result.message });
  }

  private async readFlow(): Promise<void> {
    if (this.job.kind === "running") return;
    if (!this.selectedChip) {
      this.showNotice("Select a chip before reading.", "error");
      return;
    }
    const selectedChip = this.selectedChip;
    const advanced = { ...this.advanced };
    const fileDirectory = this.fileDirectory;

    const outputFile = await this.dialogs.filename("Read Chip", join(fileDirectory, defaultReadFilename(selectedChip)));
    if (!outputFile) {
      this.appendLog("Read cancelled.");
      return;
    }

    let destinationSnapshot: DestinationSnapshot;
    try {
      destinationSnapshot = await captureDestination(outputFile);
    } catch (error) {
      this.showNotice(`Cannot inspect read destination: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    if (destinationSnapshot.exists) {
      await this.dialogs.message("Read File Exists", "Choose a new output filename. Existing files are never replaced by a hardware read.");
      this.appendLog("Read cancelled to preserve the existing file.");
      return;
    }

    const confirmed = await this.dialogs.confirm(
      "Read Chip",
      [`Read ${selectedChip} directly over USB to:`, outputFile, "", ...dangerousOptionWarnings(advanced)].join("\n"),
      "Read",
    );
    if (!confirmed) {
      this.appendLog("Read cancelled.");
      return;
    }

    this.setJob({ kind: "running", step: "read" });
    const result = await this.runBackendAction(true, (signal) => runReadWorkflow({
      backend: this.requireBackend(), chip: selectedChip, programmerKind: this.database,
      outputFile, destinationSnapshot, confirmed: true, advanced, signal,
      onStep: (step, cancellable) => { this.setJob({ kind: "running", step }); this.activeCommandCancellable = cancellable; },
      onLog: (line) => this.appendLog(line),
    })).catch((error) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error), steps: [] }));

    this.appendLog(result.message);
    this.setJob(result.ok ? { kind: "done", message: result.message } : { kind: "failed", step: "read", message: result.message });
    if (result.ok) await this.refresh();
  }

  private async compareFlow(): Promise<void> {
    if (this.job.kind === "running") return;
    if (!this.selectedFile) {
      this.showNotice("Select an image before comparing.", "error");
      return;
    }
    if (!this.selectedChip) {
      this.showNotice("Select a chip before comparing.", "error");
      return;
    }
    const selectedChip = this.selectedChip;
    const selectedFile = this.selectedFile;
    const advanced = { ...this.advanced };

    const frozen = await freezeFileForOperation(selectedFile.path);
    if (!frozen.ok) {
      this.showNotice(frozen.message, "error");
      return;
    }

    const confirmed = await this.dialogs.confirm(
      "Compare Chip",
      [
        `Compare ${basename(selectedFile.path)} with the current contents of ${selectedChip}.`,
        `Local file: ${frozen.bytes.byteLength} B sha256 ${frozen.sha256}`,
        "",
        "Read the chip directly over USB, then compare every byte.",
        "",
        ...dangerousOptionWarnings(advanced),
      ].join("\n"),
      "Compare",
    );
    if (!confirmed) {
      this.appendLog("Compare cancelled.");
      return;
    }

    this.setJob({ kind: "running", step: "compare" });
    const result = await this.runBackendAction(true, (signal) => runCompareWorkflow({
      backend: this.requireBackend(), file: selectedFile, chip: selectedChip, programmerKind: this.database,
      confirmed: true, confirmedBytes: frozen.bytes, confirmedSha256: frozen.sha256,
      advanced, signal,
      onStep: (step, cancellable) => { this.setJob({ kind: "running", step }); this.activeCommandCancellable = cancellable; },
      onLog: (line) => this.appendLog(line),
    })).catch((error) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error), steps: [] }));

    this.appendLog(result.message);
    this.setJob(result.ok ? { kind: "done", message: result.message } : { kind: "failed", step: "compare", message: result.message });
    await this.dialogs.message("Compare Result", result.message);
  }

  private async advancedModal(): Promise<void> {
    const previous = JSON.stringify({ showAllFiles: this.showAllFiles, advanced: this.advanced });
    const previousShowAllFiles = this.showAllFiles;
    await this.dialogs.switches("Advanced Controls", [
      {
        label: "SHOW ALL FILE TYPES",
        description: "Include files outside the supported programming-image extensions.",
        checked: this.showAllFiles,
        onCheckedChange: (checked) => { this.showAllFiles = checked; },
      },
      {
        label: "PRE-WRITE BACKUP",
        description: "Read the current chip to a new file before erase begins.",
        checked: Boolean(this.advanced.backupBeforeWrite),
        onCheckedChange: (checked) => { this.advanced.backupBeforeWrite = checked; },
      },
      {
        label: "DISABLE WRITE PROTECTION",
        description: "Dangerous: disable supported software protection before programming.",
        checked: Boolean(this.advanced.unprotectBefore),
        onCheckedChange: (checked) => { this.advanced.unprotectBefore = checked; },
        tone: "danger",
      },
      {
        label: "ALLOW SIZE MISMATCH",
        description: "Dangerous: permit image and chip capacity to differ.",
        checked: Boolean(this.advanced.allowSizeMismatch),
        onCheckedChange: (checked) => { this.advanced.allowSizeMismatch = checked; },
        tone: "danger",
      },
      {
        label: "DISABLE READBACK COMPARE",
        description: "Dangerous: skip the independent post-write byte comparison.",
        checked: Boolean(this.advanced.disableReadbackCompare),
        onCheckedChange: (checked) => { this.advanced.disableReadbackCompare = checked; },
        tone: "danger",
      },
      {
        label: "SKIP EXPLICIT ERASE",
        description: "Proceed only if the chip already passes the mandatory blank check.",
        checked: Boolean(this.advanced.skipErase),
        onCheckedChange: (checked) => { this.advanced.skipErase = checked; },
      },
      {
        label: "SKIP VERIFY",
        description: "Dangerous: skip the programmer's post-write verification pass.",
        checked: Boolean(this.advanced.skipVerify),
        onCheckedChange: (checked) => { this.advanced.skipVerify = checked; },
        tone: "danger",
      },
      {
        label: "IGNORE ID MISMATCH",
        description: "Dangerous: continue when the detected chip ID does not match.",
        checked: Boolean(this.advanced.ignoreIdMismatch),
        onCheckedChange: (checked) => { this.advanced.ignoreIdMismatch = checked; },
        tone: "danger",
      },
      {
        label: "SKIP ID READ",
        description: "Dangerous for reads: do not identify the chip before accessing it.",
        checked: Boolean(this.advanced.skipIdRead),
        onCheckedChange: (checked) => { this.advanced.skipIdRead = checked; },
        tone: "danger",
      },
    ]);
    if (previousShowAllFiles !== this.showAllFiles) await this.refreshFiles();
    if (previous !== JSON.stringify({ showAllFiles: this.showAllFiles, advanced: this.advanced })) {
      this.appendLog(`Advanced options: ${JSON.stringify(this.advanced)}`);
      this.queueStateSave();
    }
    this.render();
  }

  private async help(): Promise<void> {
    await this.dialogs.message(
      "Keyboard Reference",
      [
        "Navigation",
        "  Tab        Move focus forward",
        "  Shift+Tab  Move focus backward",
        "  Enter      Activate the selected item",
        "  F          Focus file search",
        "  /          Focus chip search",
        "  Esc        Leave an active search field",
        "  Mouse      Click another pane to leave search",
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
  }

  private async showChipInfo(): Promise<void> {
    if (!this.selectedChip || !this.chipInfo) {
      this.showNotice("Select a chip and wait for its details before opening chip info.", "error");
      return;
    }
    await this.dialogs.message(`Chip Details: ${this.selectedChip}`, formatChipInfo(this.chipInfo));
  }

  private async quit(): Promise<void> {
    if (this.job.kind === "running" || this.operationPending) {
      await this.dialogs.message("Job Running", "A hardware command is running. Quit is disabled until the command exits.");
      return;
    }
    this.shuttingDown = true;
    this.chipSearchRequestId++;
    this.chipInfoRequestId++;
    this.chipSearchAbortController?.abort();
    await this.backend?.close();
    this.queueStateSave();
    await this.stateSave;
    this.renderer?.destroy();
    if (this.options.exit) this.options.exit(0);
    else process.exit(0);
  }

  private startOperation(operation: () => Promise<void>): void {
    if (this.operationPending || this.job.kind === "running") return;
    this.operationPending = true;
    this.clearFeedback();
    this.chipSearchAbortController?.abort();
    this.chipSearch = undefined;
    this.chipSearchRequestId++;
    this.chipInfoRequestId++;
    void operation()
      .catch((error) => this.setJob({ kind: "failed", step: "operation", message: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        this.operationPending = false;
        this.render();
      });
  }

  private applyResponsiveLayout(): void {
    const renderer = this.requireRenderer();
    const components = this.requireComponents();
    const compact = renderer.width < COMPACT_WIDTH || renderer.height < COMPACT_HEIGHT;
    if (compact === this.compactMode) return;

    if (compact) {
      const focus = this.focusLabel();
      if (focus === "Dialog" && this.modalOriginPanel) this.compactPanel = this.modalOriginPanel;
      else if (focus === "Chip Search" || focus === "Chip Results") this.compactPanel = "chips";
      else if (focus === "Log") this.compactPanel = "log";
      else if (focus === "File Search" || focus === "Files") this.compactPanel = "files";
      components.main.remove(components.topRow);
      components.main.remove(components.logPanel);
      components.main.insertBefore(components.compactTabs, components.footerBox);
      components.main.insertBefore(components.compactContent, components.footerBox);
      components.brandBadge.visible = false;
      components.compactBrandBadge.visible = true;
      components.buildLabel.visible = false;
      this.compactMode = true;
      this.setCompactPanel(this.compactPanel);
    } else {
      for (const child of components.compactContent.getChildren()) components.compactContent.remove(child);
      if (components.compactTabs.parent === components.main) components.main.remove(components.compactTabs);
      if (components.compactContent.parent === components.main) components.main.remove(components.compactContent);

      for (const panel of [components.filesPanel, components.chipPanel, components.statusPanel]) {
        panel.parent?.remove(panel);
        panel.width = "auto";
        panel.flexBasis = 0;
        panel.marginBottom = 0;
      }
      components.filesPanel.flexGrow = 1.2;
      components.chipPanel.flexGrow = 0.9;
      components.statusPanel.flexGrow = 1.1;
      components.filesPanel.marginRight = 1;
      components.chipPanel.marginRight = 1;
      components.statusPanel.marginRight = 0;
      components.topRow.add(components.filesPanel);
      components.topRow.add(components.chipPanel);
      components.topRow.add(components.statusPanel);
      components.main.insertBefore(components.topRow, components.footerBox);
      components.main.insertBefore(components.logPanel, components.footerBox);
      components.brandBadge.visible = true;
      components.compactBrandBadge.visible = false;
      components.buildLabel.visible = true;
      this.compactMode = false;
      if (components.compactTabs.focused) {
        const target = this.compactPanel === "chips" ? components.chipQuery : this.compactPanel === "log" ? components.log : components.fileQuery;
        target.focus();
      }
    }
    this.render();
  }

  private showCompactPanel(panel: CompactPanel): void {
    if (!this.compactMode) return;
    this.setCompactPanel(panel);
    this.requireComponents().compactTabs.setSelectedIndex(compactPanelIndex(panel));
  }

  private setCompactPanel(panel: CompactPanel): void {
    if (!this.compactMode) return;
    const components = this.requireComponents();
    const moveFocus = panel !== this.compactPanel && !components.compactTabs.focused && this.focusableControls().some((control) => control.focused);
    const next = panel === "files" ? components.filesPanel : panel === "chips" ? components.chipPanel : panel === "status" ? components.statusPanel : components.logPanel;
    for (const child of components.compactContent.getChildren()) {
      if (child !== next) components.compactContent.remove(child);
    }
    next.parent?.remove(next);
    next.width = "100%";
    next.flexGrow = 1;
    next.marginRight = 0;
    next.marginBottom = 0;
    components.compactContent.add(next);
    this.compactPanel = panel;
    if (moveFocus) {
      const target = panel === "files" ? components.fileQuery : panel === "chips" ? components.chipQuery : panel === "log" ? components.log : components.compactTabs;
      target.focus();
    }
    this.render();
  }

  private exitSearchInput(): boolean {
    const components = this.requireComponents();
    if (components.fileQuery.focused) {
      components.fileQuery.blur();
      components.files.focus();
      this.render();
      return true;
    }
    if (components.chipQuery.focused) {
      components.chipQuery.value = this.chipQuery;
      components.chipQuery.blur();
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

    if (activeSearch === "files") components.fileQuery.blur();
    else {
      components.chipQuery.value = this.chipQuery;
      components.chipQuery.blur();
    }
    if (pointInRenderable(components.filesPanel, x, y)) components.files.focus();
    else if (pointInRenderable(components.chipPanel, x, y)) components.chips.focus();
    else if (pointInRenderable(components.logPanel, x, y)) components.log.focus();
    else if (activeSearch === "files") components.files.focus();
    else components.chips.focus();
    this.render();
  }

  private handleCompactTabPointerDown(event: MouseEvent): void {
    const components = this.requireComponents();
    const index = Math.floor((event.x - components.compactTabs.screenX) / components.compactTabs.getTabWidth());
    const panel = (["files", "chips", "status", "log"] as const)[index];
    if (!panel) return;

    event.preventDefault();
    event.stopPropagation();
    this.showCompactPanel(panel);
    const target = panel === "files" ? components.fileQuery : panel === "chips" ? components.chipQuery : panel === "log" ? components.log : components.compactTabs;
    target.focus();
    this.render();
  }

  private focusNext(reverse = false): void {
    const focusables = this.focusableControls();
    const current = focusables.findIndex((item) => item.focused);
    const next = current === -1 ? (reverse ? focusables.length - 1 : 0) : (current + (reverse ? -1 : 1) + focusables.length) % focusables.length;
    focusables[next]?.focus();
    this.render();
  }

  private focusableControls(): Array<InputRenderable | SelectRenderable | ScrollBoxRenderable | TabSelectRenderable> {
    const components = this.requireComponents();
    if (!this.compactMode) return [components.fileQuery, components.files, components.chipQuery, components.chips, components.log];
    if (this.compactPanel === "files") return [components.compactTabs, components.fileQuery, components.files];
    if (this.compactPanel === "chips") return [components.compactTabs, components.chipQuery, components.chips];
    if (this.compactPanel === "log") return [components.compactTabs, components.log];
    return [components.compactTabs];
  }

  private setJob(job: JobState): void {
    this.job = job;
    this.render();
  }

  private showNotice(message: string, tone: Notice["tone"] = "info"): void {
    this.notice = { tone, message };
    this.appendLog(message);
  }

  private clearFeedback(): void {
    this.notice = undefined;
    if (this.job.kind === "done" || this.job.kind === "failed") this.job = { kind: "idle" };
  }

  private appendLog(line: string): void {
    for (const part of line.split(/\r?\n|\r/)) {
      const sanitized = sanitizeLogLine(part);
      if (sanitized.trim()) this.logLines.push(sanitized);
    }
    if (this.logLines.length > LOG_LINE_LIMIT) this.logLines.splice(0, this.logLines.length - LOG_LINE_LIMIT);
    this.render();
  }

  private render(): void {
    if (!this.components || this.components.statusChrome.isDestroyed || this.shuttingDown) return;
    const focus = this.focusLabel();
    this.statusLine = `${formatStatusLine({
      programmerStatus: this.programmerStatus,
      database: this.database,
      selectedChip: this.selectedChip,
      selectedFile: this.selectedFile,
      job: this.job,
    })}  //  FOCUS ${focus.toUpperCase()}`;
    const filteredFileEntries = filterFileTreeEntries(this.fileTreeEntries, this.fileQuery, this.fileDirectory);
    const visibleFileEntries = this.fileQuery.trim() ? filteredFileEntries : orderFileTreeEntries(filteredFileEntries, this.recentFilePaths, this.recentDirectories);
    const fileOptions = visibleFileEntries.length > 0
      ? visibleFileEntries.map((entry) => formatFileTreeDisplayOption(entry, this.selectedFile?.path, this.recentFilePaths, this.recentDirectories))
      : [formatFileEmptyOption(this.fileDirectory, this.fileQuery, this.showAllFiles)];
    this.updateSelectOptions(this.components.files, fileOptions, visibleFileEntries.length > 0 ? visibleFileEntries.map(formatFileTreeOptionKey).join("\n") : "<no-files>");
    this.setSelectedIndex(this.components.files, fileOptions.findIndex((option) => option.value === this.selectedFile?.path));
    const visibleChips = orderByRecents(this.chipResults, this.recentChips);
    const waitingForChipResults = this.chipSearch?.phase === "results";
    const chipOptions = waitingForChipResults
      ? [formatChipSearchOption(this.chipQuery)]
      : visibleChips.length > 0
        ? formatChipOptions(visibleChips, this.chipInfoCache)
        : [formatChipEmptyOption(this.chipQuery)];
    this.updateSelectOptions(this.components.chips, chipOptions, waitingForChipResults ? `<search:${this.chipSearch?.requestId}>` : visibleChips.length > 0 ? visibleChips.map((chip) => `${chip}:${chip === this.selectedChip}:${this.recentChips.includes(chip)}:${this.chipInfoCache.get(chip)?.raw ?? ""}`).join("\n") : "<no-chips>");
    this.setSelectedIndex(this.components.chips, chipOptions.findIndex((option) => option.value === this.selectedChip));
    this.renderFocusState(focus);
    const statusSummaryWidth = this.components.statusSummary.width > 0 ? this.components.statusSummary.width : undefined;
    this.components.statusSummary.content = formatStatusSummaryContent({
      programmerStatus: this.programmerStatus,
      database: this.database,
      selectedChip: this.selectedChip,
      selectedFile: this.selectedFile,
      chipInfo: this.chipInfo,
      job: this.job,
      advanced: this.advanced,
      fileCount: this.files.length,
      chipResultCount: this.chipResults.length,
      showAllFiles: this.showAllFiles,
    }, { width: statusSummaryWidth });
    this.components.logText.content = formatLogContent(this.logLines.slice(-500));
    this.guidanceLine = formatGuidanceLine({
      programmerStatus: this.programmerStatus,
      database: this.database,
      selectedChip: this.selectedChip,
      selectedFile: this.selectedFile,
      chipInfo: this.chipInfo,
      job: this.job,
      advanced: this.advanced,
      activeCommandCancellable: this.activeCommandCancellable,
      notice: this.notice,
      chipSearch: this.chipSearch,
    });
    this.components.connectedBadge.visible = this.programmerStatus.connected;
    this.components.disconnectedBadge.visible = !this.programmerStatus.connected;
    this.components.t48Badge.visible = !this.compactMode && this.database === "t48";
    this.components.t56Badge.visible = !this.compactMode && this.database === "t56";
    this.components.t76Badge.visible = !this.compactMode && this.database === "t76";
    const jobLabel = this.job.kind === "running" ? this.job.step : this.job.kind;
    this.components.statusChrome.content = this.compactMode
      ? ` ${jobLabel.toUpperCase()}  //  ${focus.toUpperCase()}`
      : this.statusLine;
    this.components.guidanceChrome.content = this.guidanceLine;
    this.components.guidanceChrome.fg = this.notice?.tone === "error" || this.job.kind === "failed"
      ? tuiTheme.destructive
      : this.job.kind === "done"
        ? tuiTheme.success
        : this.job.kind === "running"
          ? tuiTheme.warning
          : MUTED;
    this.components.footerText.content = formatKeyHints(footerHints(focus, this.compactMode, this.activeCommandCancellable));
    this.renderer?.root.requestRender();
  }

  private updateSelectOptions(select: SelectRenderable, options: SelectOption[], key: string): void {
    const isFiles = select === this.components?.files;
    const currentKey = isFiles ? this.fileOptionsKey : this.chipOptionsKey;
    if (currentKey === key) return;

    select.options = options;
    if (isFiles) this.fileOptionsKey = key;
    else this.chipOptionsKey = key;
  }

  private setSelectedIndex(select: SelectRenderable, index: number): void {
    const next = Math.max(0, index);
    if (select.getSelectedIndex() !== next) select.setSelectedIndex(next);
  }

  private focusLabel(): string {
    const components = this.requireComponents();
    if (components.fileQuery.focused) return "File Search";
    if (components.files.focused) return "Files";
    if (components.chipQuery.focused) return "Chip Search";
    if (components.chips.focused) return "Chip Results";
    if (components.log.focused) return "Log";
    if (components.compactTabs.focused) return "Sections";
    return "Dialog";
  }

  private renderFocusState(focus: string): void {
    const components = this.requireComponents();
    setPanelFocus(
      components.filesPanel,
      `01 IMAGE // ${formatDirectoryLabel(this.fileDirectory).toUpperCase()}`,
      focus === "File Search" || focus === "Files",
      focus === "File Search" ? " [Enter/Esc] results " : undefined,
    );
    setPanelFocus(
      components.chipPanel,
      "02 DEVICE CATALOG",
      focus === "Chip Search" || focus === "Chip Results",
      focus === "Chip Search" ? " [Enter] search  [Esc] results " : undefined,
    );
    setPanelFocus(components.statusPanel, "03 WRITE RECEIPT", false);
    setPanelFocus(components.logPanel, "04 OPERATION TRACE", focus === "Log");
    components.fileSearchBox.borderColor = focus === "File Search" ? PRIMARY : BORDER;
    components.chipSearchBox.borderColor = focus === "Chip Search" ? PRIMARY : BORDER;
  }

  private restoreState(state: PersistedState): void {
    this.database = state.database;
    this.showAllFiles = state.showAllFiles;
    this.advanced = { ...DEFAULT_ADVANCED_OPTIONS, backupBeforeWrite: state.advanced.backupBeforeWrite };
    this.recentFilePaths = state.recentFilePaths;
    this.recentDirectories = state.recentDirectories;
    this.recentChips = state.recentChips;
    this.recentDatabases = state.recentDatabases;
  }

  private queueStateSave(): void {
    if (this.options.persistence === false) return;
    const state: PersistedState = {
      version: 1,
      database: this.database,
      showAllFiles: this.showAllFiles,
      advanced: { backupBeforeWrite: this.advanced.backupBeforeWrite },
      recentFilePaths: [...this.recentFilePaths],
      recentDirectories: [...this.recentDirectories],
      recentChips: [...this.recentChips],
      recentDatabases: [...this.recentDatabases],
    };
    this.stateSave = this.stateSave
      .catch(() => undefined)
      .then(() => saveState(state))
      .catch((error) => {
        if (this.components) this.appendLog(`Cannot save preferences: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private requireRenderer(): CliRenderer {
    if (!this.renderer) throw new Error("Renderer is not initialized.");
    return this.renderer;
  }

  private requireComponents(): Components {
    if (!this.components) throw new Error("Components are not initialized.");
    return this.components;
  }

  private requireBackend(): ProgrammerBackend {
    if (!this.backend) throw new Error("Programmer backend is not initialized.");
    return this.backend;
  }

  private readOptions(signal?: AbortSignal): ReadOptions {
    if (!this.selectedChip) throw new Error("No chip is selected.");
    return {
      chip: this.selectedChip,
      programmerKind: this.database,
      skipIdCheck: this.advanced.skipIdRead,
      continueOnIdMismatch: this.advanced.ignoreIdMismatch,
      signal,
    };
  }

  private captureFocusedControl(): (() => void) | undefined {
    const components = this.components;
    if (!components) return undefined;
    for (const control of this.focusableControls()) {
      if (control.focused) {
        return () => {
          const focusables = this.focusableControls();
          if (focusables.includes(control)) control.focus();
          else focusables[0]?.focus();
        };
      }
    }
    return undefined;
  }
}

function panel(renderer: CliRenderer, id: string, title: string): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    title: ` ${title} `,
    titleColor: MUTED,
    border: true,
    borderStyle: "single",
    borderColor: BORDER,
    focusedBorderColor: PRIMARY,
    backgroundColor: PANEL,
    paddingTop: 1,
    paddingLeft: 1,
    paddingRight: 1,
    flexGrow: 1,
    flexBasis: 0,
    flexDirection: "column",
  });
}

function searchBox(renderer: CliRenderer, id: string): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    height: 3,
    width: "100%",
    backgroundColor: PANEL,
    border: true,
    borderStyle: "single",
    borderColor: BORDER,
    paddingLeft: 1,
    paddingRight: 1,
    marginBottom: 1,
  });
}

function selectOptions(id: string, height: number | `${number}%`): ConstructorParameters<typeof SelectRenderable>[1] {
  return {
    id,
    width: "100%",
    height,
    options: [],
    backgroundColor: PANEL,
    focusedBackgroundColor: PANEL,
    textColor: TEXT,
    focusedTextColor: TEXT,
    selectedBackgroundColor: PRIMARY,
    selectedTextColor: SELECTED_TEXT,
    descriptionColor: MUTED,
    selectedDescriptionColor: SELECTED_TEXT,
    showScrollIndicator: true,
    showSelectionIndicator: false,
    wrapSelection: true,
  };
}

function footerHints(focus: string, compact: boolean, cancellable: boolean): KeyHint[] {
  if (cancellable) return [{ key: "Esc", label: "cancel current step" }, { key: "?", label: "help" }];
  const focusHint: KeyHint[] = compact ? [] : [{ key: "Tab", label: "move focus" }];
  switch (focus) {
    case "File Search":
      return [{ key: "Type", label: "filter" }, { key: "Enter/Esc", label: "results" }, ...focusHint, { key: "/", label: "device" }, { key: "?", label: "help" }];
    case "Files":
      return compact
        ? [{ key: "Up/Down", label: "move" }, { key: "Enter", label: "open" }, { key: "Bksp", label: "up" }, { key: "F", label: "filter" }, { key: "/", label: "device" }]
        : [{ key: "Up/Down", label: "browse" }, { key: "Enter", label: "open" }, { key: "Bksp", label: "up" }, { key: "F", label: "filter" }, { key: "/", label: "device" }, { key: "W", label: "write" }];
    case "Chip Search":
      return [{ key: "Type", label: "query" }, { key: "Enter", label: "search" }, { key: "Esc", label: "results" }, ...focusHint, { key: "F", label: "image" }, { key: "?", label: "help" }];
    case "Chip Results":
      return compact
        ? [{ key: "Up/Down", label: "browse" }, { key: "Enter", label: "select" }, { key: "/", label: "search" }, { key: "I", label: "info" }]
        : [{ key: "Up/Down", label: "browse" }, { key: "Enter", label: "select" }, { key: "/", label: "search" }, { key: "I", label: "info" }, { key: "W", label: "write" }];
    case "Log":
      return [{ key: "Up/Down", label: "scroll" }, { key: "Tab", label: "move focus" }, { key: "?", label: "help" }, { key: "Q", label: "quit" }];
    case "Sections":
      return [{ key: "Left/Right", label: "section" }, { key: "Enter", label: "open" }, { key: "Tab", label: "move focus" }, { key: "?", label: "help" }];
    default:
      return [{ key: "Tab", label: "move focus" }, { key: "?", label: "help" }, { key: "Q", label: "quit" }];
  }
}

function formatWriteActionSummary(options: AdvancedOptions, backup: boolean): string {
  const stages = [
    "check",
    backup ? "back up" : undefined,
    options.skipErase ? undefined : "erase",
    "blank-check",
    "write",
    options.skipVerify ? undefined : "verify",
    options.disableReadbackCompare ? undefined : "read back",
  ].filter((stage): stage is string => Boolean(stage));
  return `This will ${stages.join(", ")}`;
}

function truncateEnd(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 3) return ".".repeat(width);
  return `${value.slice(0, width - 3)}...`;
}

function orderChipResults(chips: string[], query: string): string[] {
  const packagedNames = new Set(chips.filter((chip) => chip.includes("@")).map(chipBaseName));
  const deduplicated = chips.filter((chip) => chip.includes("@") || !packagedNames.has(chipBaseName(chip)));
  const seen = new Set<string>();
  const ordered: string[] = [];
  const preferred = query === DEFAULT_CHIP_QUERY
    ? [
        ...deduplicated.filter((chip) => chipBaseName(chip) === DEFAULT_CHIP_QUERY.toLowerCase()),
        SECONDARY_DEFAULT_CHIP,
      ]
    : deduplicated.filter((chip) => chipBaseName(chip) === DEFAULT_CHIP_QUERY.toLowerCase() || chip === SECONDARY_DEFAULT_CHIP);

  for (const chip of [...preferred, ...deduplicated]) {
    if (seen.has(chip)) continue;
    seen.add(chip);
    ordered.push(chip);
  }

  return ordered;
}

function chipBaseName(chip: string): string {
  return (chip.split("@")[0] ?? chip).toLowerCase();
}

function formatChipOptions(chips: string[], infoByChip: Map<string, ChipInfo>): SelectOption[] {
  return chips.map((chip) => formatChipLabel(chip, infoByChip.get(chip)));
}

function formatFileTreeDisplayOption(entry: FileTreeEntry, selectedPath: string | undefined, recentFiles: string[], recentDirectories: string[]): SelectOption {
  const option = formatFileTreeOption(entry);
  const current = entry.kind !== "directory" && entry.path === selectedPath;
  const recent = entry.kind === "directory" ? recentDirectories.includes(entry.path) : recentFiles.includes(entry.path);
  return {
    ...option,
    name: formatCurrentName(option.name, current),
    description: formatRecentDescription(recent, current, option.description),
  };
}

function formatCurrentName(name: string, current: boolean): string {
  return current ? `> ${name}` : `  ${name}`;
}

function formatRecentDescription(recent: boolean, current: boolean, description = ""): string {
  const labels = [current ? "current" : undefined, recent && !current ? "recent" : undefined].filter((label): label is string => Boolean(label));
  if (labels.length === 0) return description;
  return description ? `${labels.join(", ")} | ${description}` : labels.join(", ");
}

function formatFileEmptyOption(directory: string, query: string, showAllFiles: boolean): SelectOption {
  const relativeDirectory = formatDirectoryLabel(directory);
  if (query.trim()) {
    return { name: "No matching files", description: `No matches in ${relativeDirectory}. Clear the file search or open another directory.`, value: "" };
  }
  if (!showAllFiles) {
    return { name: "No programming files", description: `No .bin/.rom/.hex/.srec/.eep files in ${relativeDirectory}. Press a to show all files.`, value: "" };
  }
  return { name: "Empty directory", description: `No files or folders in ${relativeDirectory}. Backspace opens the parent.`, value: "" };
}

function formatChipEmptyOption(query: string): SelectOption {
  const label = query.trim() || DEFAULT_CHIP_QUERY;
  return { name: "No matching chips", description: `No ${label} results. Edit the chip query and press Enter.`, value: "" };
}

function formatChipSearchOption(query: string): SelectOption {
  return { name: "Searching chips...", description: `Querying the ${query.trim() || DEFAULT_CHIP_QUERY} device list.`, value: "" };
}

function orderFileTreeEntries(entries: FileTreeEntry[], recentFiles: string[], recentDirectories: string[]): FileTreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.name === "..") return -1;
    if (b.name === "..") return 1;
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    const aRecent = recentRank(a.kind === "directory" ? recentDirectories : recentFiles, a.path);
    const bRecent = recentRank(b.kind === "directory" ? recentDirectories : recentFiles, b.path);
    if (aRecent !== bRecent) return aRecent - bRecent;
    return 0;
  });
}

function orderByRecents<T>(items: T[], recents: T[]): T[] {
  return [...items].sort((a, b) => recentRank(recents, a) - recentRank(recents, b));
}

function recentRank<T>(recents: T[], value: T): number {
  const index = recents.indexOf(value);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function rememberRecent<T>(items: T[], value: T): T[] {
  return [value, ...items.filter((item) => item !== value)].slice(0, RECENT_LIMIT);
}

function filterFileTreeEntries(entries: FileTreeEntry[], query: string, directory: string): FileTreeEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return entries;

  return entries
    .map((entry, index) => ({ entry, index, score: fileTreeMatchScore(entry, trimmed, directory) }))
    .filter((item) => item.entry.kind === "directory" && item.entry.name === ".." || item.score > 0)
    .sort((a, b) => {
      if (a.entry.name === "..") return -1;
      if (b.entry.name === "..") return 1;
      if (b.score !== a.score) return b.score - a.score;
      if (a.entry.kind !== b.entry.kind) return a.entry.kind === "directory" ? -1 : 1;
      return a.index - b.index;
    })
    .map((item) => item.entry);
}

function fileTreeMatchScore(entry: FileTreeEntry, query: string, directory: string): number {
  const haystacks = [entry.name, relative(directory, entry.path)].filter(Boolean);
  return Math.max(...haystacks.map((value) => fuzzyScore(value, query)));
}

function fuzzyScore(value: string, query: string): number {
  const target = value.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let position = 0;
  let lastMatch = -1;

  for (const char of needle) {
    const found = target.indexOf(char, position);
    if (found === -1) return 0;
    score += 10;
    if (found === lastMatch + 1) score += 5;
    if (found === 0 || /[\s._/-]/.test(target[found - 1] ?? "")) score += 3;
    lastMatch = found;
    position = found + 1;
  }

  if (target.startsWith(needle)) score += 20;
  return score - Math.min(target.length, 80) / 100;
}

function formatFileTreeOptionKey(entry: FileTreeEntry): string {
  if (entry.kind === "directory") return `dir:${entry.path}:${entry.modifiedAt.getTime()}`;
  return `file:${entry.path}:${entry.size}:${entry.modifiedAt.getTime()}:${entry.sha256Short}`;
}

function formatDirectoryLabel(directory: string): string {
  const relativePath = relative(process.cwd(), directory);
  return relativePath ? truncateEnd(relativePath, 24) : ".";
}

function pointInRenderable(renderable: { screenX: number; screenY: number; width: number; height: number }, x: number, y: number): boolean {
  return x >= renderable.screenX && x < renderable.screenX + renderable.width && y >= renderable.screenY && y < renderable.screenY + renderable.height;
}

function setPanelFocus(panel: BoxRenderable, title: string, focused: boolean, shortcut?: string): void {
  panel.title = ` ${title} `;
  panel.titleColor = focused ? PRIMARY : MUTED;
  panel.borderStyle = "single";
  panel.borderColor = focused ? PRIMARY : BORDER;
  panel.bottomTitle = focused ? shortcut ?? panelShortcut(panel.id) : undefined;
  panel.bottomTitleAlignment = "right";
}

function panelShortcut(id: string): string | undefined {
  switch (id) {
    case "files-panel": return " [Enter] open ";
    case "chip-panel": return " [Enter] choose ";
    case "log-panel": return " [↑/↓] scroll ";
    default: return undefined;
  }
}

function isProgrammerKind(value: string): value is ProgrammerKind {
  return value === "t48" || value === "t56" || value === "t76";
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function createDefaultBackend(): Promise<ProgrammerBackend> {
  const { createXgecuBackend } = await import("./xgecu/direct");
  return createXgecuBackend();
}

function formatWritePreview(chip: ChipInfo, advanced: AdvancedOptions, backup: boolean): string {
  return [
    backup ? "1. Read and save a pre-write backup." : undefined,
    chip.supportsPinCheck ? "1. Check pin contacts." : undefined,
    advanced.unprotectBefore ? "Disable supported software write protection before programming." : undefined,
    `2. ${chip.canErase && !advanced.skipErase ? "Erase, then blank-check" : "Blank-check"} the chip.`,
    "3. Write the frozen image bytes.",
    advanced.skipVerify ? undefined : "4. Verify through the xgecu backend.",
    advanced.disableReadbackCompare ? undefined : "5. Read back and compare every byte independently.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function isCompactPanel(value: unknown): value is CompactPanel {
  return value === "files" || value === "chips" || value === "status" || value === "log";
}

function compactPanelIndex(panel: CompactPanel): number {
  return panel === "files" ? 0 : panel === "chips" ? 1 : panel === "status" ? 2 : 3;
}

function isEscapeKey(key: KeyEvent): boolean {
  return key.name === "escape" || key.name === "esc" || key.raw === "\x1b" || key.sequence === "\x1b";
}

function consumeKey(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

function defaultReadFilename(chip: string): string {
  const stamp = filenameTimestamp();
  return `${sanitizeFilename(chip)}-${stamp}.bin`;
}

function defaultBackupFilename(chip: string): string {
  return `${sanitizeFilename(chip)}-backup-${filenameTimestamp()}.bin`;
}

function filenameTimestamp(): string {
  return new Date().toISOString().replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "readback";
}

async function freezeFileForOperation(path: string): Promise<{ ok: true; bytes: Uint8Array; sha256: string } | { ok: false; message: string }> {
  try {
    const before = await stat(path);
    if (before.size > MAX_IMAGE_FILE_BYTES) return { ok: false, message: `Selected image exceeds the ${MAX_IMAGE_FILE_BYTES} byte operation limit.` };
    const bytes = await readFile(path);
    const after = await stat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return { ok: false, message: "Selected file changed while preparing the operation. Refresh and reselect it before continuing." };
    }
    const normalized = normalizeImageBytes(path, bytes);
    return { ok: true, bytes: normalized, sha256: sha256Bytes(normalized) };
  } catch (error) {
    return { ok: false, message: `Cannot read selected file before confirmation: ${error instanceof Error ? error.message : String(error)}` };
  }
}
