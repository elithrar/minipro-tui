import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

import {
  BoxRenderable,
  CliRenderEvents,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  RenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core";

import type { AdvancedOptions, ChipInfo, FileEntry, FileTreeEntry, JobState, ProgrammerDatabase, ProgrammerKind, ProgrammerStatus } from "./types";
import { sha256Bytes } from "./files/hash";
import { MAX_IMAGE_FILE_BYTES, normalizeImageBytes } from "./files/image";
import { isFileEntry, scanFileTree } from "./files/scan";
import {
  buildBlankCheckArgs,
  buildDefaultWritePreview,
  buildDetectProgrammerArgs,
  buildPinCheckArgs,
  buildVerifyArgs,
  buildSearchChipsArgs,
  buildChipInfoArgs,
  buildReadArgs,
  runMinipro,
} from "./minipro/commands";
import { parseChipInfo, parseChipSearch, parseProgrammerDatabases, parseProgrammerStatus } from "./minipro/parse";
import { captureDestination, runCompareWorkflow, runDefaultWriteWorkflow, runReadWorkflow, type DestinationSnapshot } from "./minipro/workflow";
import { DEFAULT_ADVANCED_OPTIONS, dangerousOptionWarnings } from "./safety/options";
import { loadState, saveState, type PersistedState } from "./state";
import { DialogController } from "./tui/dialogs";
import { formatChipInfo, formatChipLabel, formatFileTreeOption, formatLogContent, formatStatusLine, formatStatusSummaryContent, sanitizeLogLine } from "./tui/render";

const PRIMARY = "#ff8a00";
const BG = "#0a0a0a";
const PANEL = "#141414";
const ELEMENT = "#1e1e1e";
const ELEMENT_FOCUSED = "#282828";
const BORDER = "#484848";
const BORDER_ACTIVE = "#606060";
const TEXT = "#eeeeee";
const SELECTED_TEXT = "#0a0a0a";
const MUTED = "#808080";
const CONNECTED = "#11261a";
const DISCONNECTED = "#2a1619";
const CHROME_FG = RGBA.fromHex(TEXT);
const DEFAULT_DATABASE: ProgrammerKind = "t48";
const DEFAULT_CHIP_QUERY = "AT28C64B";
const SECONDARY_DEFAULT_CHIP = "M27C64A@DIP28";
const CHIP_INFO_PREFETCH_LIMIT = 12;
const CHIP_INFO_PREFETCH_CONCURRENCY = 3;
const RECENT_LIMIT = 8;
const LOG_LINE_LIMIT = 2000;
const COMPACT_WIDTH = 90;
const COMPACT_HEIGHT = 22;

type CompactPanel = "files" | "chips" | "status" | "log";

export type MiniproTuiAppOptions = {
  renderer?: CliRenderer;
  commandRunner?: typeof runMinipro;
  persistence?: boolean;
  exit?: (code: number) => void;
};

type Components = {
  main: BoxRenderable;
  topRow: BoxRenderable;
  compactTabs: TabSelectRenderable;
  compactContent: BoxRenderable;
  statusBarBox: BoxRenderable;
  filesPanel: BoxRenderable;
  fileQuery: InputRenderable;
  files: SelectRenderable;
  chipPanel: BoxRenderable;
  chipQuery: InputRenderable;
  chips: SelectRenderable;
  statusPanel: BoxRenderable;
  statusSummary: TextRenderable;
  logPanel: BoxRenderable;
  log: ScrollBoxRenderable;
  logText: TextRenderable;
  footerBox: BoxRenderable;
};

export class MiniproTuiApp {
  private renderer: CliRenderer | undefined;
  private components: Components | undefined;
  private programmerStatus: ProgrammerStatus = { connected: false, raw: "" };
  private programmerDatabases: ProgrammerDatabase[] = [];
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
  private footerLine = footerText();
  private activeAbortController: AbortController | undefined;
  private activeCommandCancellable = false;
  private operationPending = false;
  private readonly activeCommandControllers = new Set<AbortController>();
  private readonly activeCommandPromises = new Set<Promise<unknown>>();
  private compactMode = false;
  private compactPanel: CompactPanel = "files";
  private modalOriginPanel: CompactPanel | undefined;
  private shuttingDown = false;
  private stateSave: Promise<void> = Promise.resolve();
  private readonly options: MiniproTuiAppOptions;
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

  constructor(options: MiniproTuiAppOptions = {}) {
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

    const statusBarBox = lineBox(renderer, "status-bar-box", DISCONNECTED, () => this.statusLine, 2);

    const main = new BoxRenderable(renderer, {
      id: "main",
      flexGrow: 1,
      width: "100%",
      flexDirection: "column",
      padding: 1,
      backgroundColor: BG,
      onMouseDown: (event) => this.handleWorkbenchPointerDown(event.x, event.y),
    });

    const compactTabs = new TabSelectRenderable(renderer, {
      id: "compact-tabs",
      width: "100%",
      height: 1,
      tabWidth: 10,
      options: [
        { name: "Files", description: "Browse images", value: "files" },
        { name: "Chips", description: "Search devices", value: "chips" },
        { name: "Status", description: "Review safety", value: "status" },
        { name: "Log", description: "Command output", value: "log" },
      ],
      showDescription: false,
      showUnderline: true,
      wrapSelection: true,
      backgroundColor: BG,
      focusedBackgroundColor: BG,
      selectedBackgroundColor: PRIMARY,
      selectedTextColor: SELECTED_TEXT,
    });
    const compactContent = new BoxRenderable(renderer, {
      id: "compact-content",
      width: "100%",
      flexGrow: 1,
      backgroundColor: BG,
      flexDirection: "column",
    });

    const topRow = new BoxRenderable(renderer, { id: "top-row", height: 15, width: "100%", flexDirection: "row", marginBottom: 1 });
    const filesPanel = panel(renderer, "files-panel", "Files");
    filesPanel.marginRight = 1;
    const fileQuery = new InputRenderable(renderer, {
      id: "file-query",
      value: "",
      placeholder: "Find files or folders",
      width: "100%",
      backgroundColor: PANEL,
      focusedBackgroundColor: ELEMENT_FOCUSED,
      textColor: TEXT,
      cursorColor: PRIMARY,
      marginBottom: 1,
    });
    fileQuery.onKeyDown = (key) => {
      if (isEscapeKey(key)) {
        consumeKey(key);
        this.exitSearchInput();
      }
    };
    const files = new SelectRenderable(renderer, selectOptions("files", "100%"));
    filesPanel.add(fileQuery);
    filesPanel.add(files);

    const chipPanel = panel(renderer, "chip-panel", "Chip Search");
    chipPanel.marginRight = 1;
    const chipQuery = new InputRenderable(renderer, {
      id: "chip-query",
      value: DEFAULT_CHIP_QUERY,
      placeholder: "AT28C64B",
      width: "100%",
      backgroundColor: PANEL,
      focusedBackgroundColor: ELEMENT_FOCUSED,
      textColor: TEXT,
      cursorColor: PRIMARY,
      marginBottom: 1,
    });
    chipQuery.onKeyDown = (key) => {
      if (isEscapeKey(key)) {
        consumeKey(key);
        this.exitSearchInput();
      }
    };
    const chips = new SelectRenderable(renderer, {
      ...selectOptions("chips", "100%"),
      showDescription: false,
      itemSpacing: 0,
    });
    chipPanel.add(chipQuery);
    chipPanel.add(chips);

    const statusPanel = panel(renderer, "status-panel", "Status");
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

    const logPanel = panel(renderer, "log-panel", "Actions / Log");
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

    const footerBox = lineBox(renderer, "footer", BG, () => this.footerLine);

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

    return { main, topRow, compactTabs, compactContent, statusBarBox, filesPanel, fileQuery, files, chipPanel, chipQuery, chips, statusPanel, statusSummary, logPanel, log, logText, footerBox };
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
          this.focusNext();
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
        this.focusNext();
        return;
      }

      if (key.name === "e") {
        consumeKey(key);
        this.showCompactPanel("chips");
        components.chipQuery.focus();
        void this.searchChip(components.chipQuery.value.trim() || this.chipQuery || DEFAULT_CHIP_QUERY, false, true);
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
          this.startOperation(() => this.singleChipAction("pin/contact check", buildPinCheckArgs));
          break;
        case "b":
          this.startOperation(() => this.singleChipAction("blank check", buildBlankCheckArgs));
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

      const databases = await this.executeCommand(["-Q"], { onLog: (line) => this.appendLog(line) });
      this.programmerDatabases = parseProgrammerDatabases(commandText(databases));
      if (this.programmerDatabases.length > 0) {
        this.appendLog(`Available programmer databases: ${this.programmerDatabases.map((db) => db.kind).join(", ")}`);
      }

      const status = await this.executeCommand(["-k"], { onLog: (line) => this.appendLog(line) });
      this.programmerStatus = status.exitCode === 0 ? parseProgrammerStatus(`${status.stdout}\n${status.stderr}`) : { connected: false, raw: `${status.stdout}\n${status.stderr}` };
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
    const components = this.requireComponents();
    components.chipQuery.value = query;
    this.appendLog(`Searching ${database} database for ${query}.`);
    const result = await this.executeCommand(buildSearchChipsArgs(database, query), { onLog: (line) => this.appendLog(line), signal: controller.signal });
    if (requestId !== this.chipSearchRequestId || this.database !== database || this.chipQuery !== query) return;
    this.chipResults = orderChipResults(result.exitCode === 0 ? parseChipSearch(result.stdout) : [], query);

    await this.prefetchChipInfo(this.chipResults.slice(0, CHIP_INFO_PREFETCH_LIMIT), database, controller.signal);
    if (requestId !== this.chipSearchRequestId || this.database !== database || this.chipQuery !== query) return;

    const defaultChip = preferDefault ? this.chipResults.find((chip) => chip === DEFAULT_CHIP_QUERY) : undefined;
    this.selectedChip = defaultChip;
    this.chipInfo = undefined;
    if (focusResults) components.chips.focus();
    this.render();

    if (defaultChip) await this.selectChip(defaultChip);
    if (this.chipSearchAbortController === controller) this.chipSearchAbortController = undefined;
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
    this.selectedFile = file;
    if (logSelection) {
      this.recentFilePaths = rememberRecent(this.recentFilePaths, file.path);
      this.queueStateSave();
      this.appendLog(`Selected file ${file.name} (${file.size} B, ${file.sha256Short}).`);
    } else if (changed) this.render();
  }

  private async openFileDirectory(path: string): Promise<void> {
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
    const result = await this.executeCommand(buildChipInfoArgs(database, chip), { onLog: (line) => this.appendLog(line) });
    if (requestId !== this.chipInfoRequestId || this.database !== database || this.selectedChip !== chip) return;
    const output = commandText(result);
    if (result.exitCode !== 0 || !output.trim()) {
      this.appendLog(`Could not load chip info for ${chip}.`);
      this.chipInfo = undefined;
      this.render();
      return;
    }
    this.chipInfo = parseChipInfo(output);
    if (!this.chipInfo.name) this.chipInfo.name = chip;
    if (this.chipInfo.raw.trim()) this.chipInfoCache.set(chip, this.chipInfo);
    this.render();
  }

  private async prefetchChipInfo(chips: string[], database: ProgrammerKind, signal: AbortSignal): Promise<void> {
    const missing = chips.filter((chip) => !this.chipInfoCache.has(chip));
    await Promise.all(
      Array.from({ length: Math.min(CHIP_INFO_PREFETCH_CONCURRENCY, missing.length) }, async () => {
        for (;;) {
          const chip = missing.shift();
          if (!chip || signal.aborted) return;
          const result = await this.executeCommand(buildChipInfoArgs(database, chip), { signal });
          if (this.database !== database || signal.aborted) return;
          const output = commandText(result);
          if (result.exitCode !== 0 || !output.trim()) continue;
          const info = parseChipInfo(output);
          if (!info.name) info.name = chip;
          this.chipInfoCache.set(chip, info);
        }
      }),
    );
  }

  private async pickProgrammerDatabase(): Promise<void> {
    if (this.job.kind === "running") return;
    const fallbackKinds: ProgrammerKind[] = ["tl866a", "tl866ii", "t48", "t56"];
    const kinds = this.programmerDatabases.length > 0 ? this.programmerDatabases.map((db) => db.kind) : fallbackKinds;
    const orderedKinds = orderByRecents(kinds, this.recentDatabases);
    const choice = await this.dialogs.select(
      "Programmer Database",
      orderedKinds.map((kind) => ({ name: formatCurrentName(kind, kind === this.database), description: formatRecentDescription(this.recentDatabases.includes(kind), kind === this.database), value: kind })),
      orderedKinds.indexOf(this.database),
    );
    if (!choice || !isProgrammerKind(String(choice.value))) return;
    this.database = String(choice.value) as ProgrammerKind;
    this.recentDatabases = rememberRecent(this.recentDatabases, this.database);
    this.queueStateSave();
    this.chipInfoCache.clear();
    this.selectedChip = undefined;
    this.chipInfo = undefined;
    this.appendLog(`Selected programmer database ${this.database}.`);
    await this.searchChip(this.chipQuery || DEFAULT_CHIP_QUERY, true);
  }

  private async singleChipAction(step: string, buildArgs: (chip: string, options?: AdvancedOptions) => string[]): Promise<void> {
    if (this.job.kind === "running") return;
    if (!this.selectedChip) {
      this.appendLog(`Cannot run ${step}: select a chip first.`);
      this.render();
      return;
    }
    await this.runConnectedAction(step, buildArgs(this.selectedChip, this.advanced));
  }

  private async verifySelectedFile(): Promise<void> {
    if (this.job.kind === "running") return;
    if (!this.selectedChip || !this.selectedFile) {
      this.appendLog("Cannot verify: select a chip and file first.");
      this.render();
      return;
    }
    const frozen = await freezeFileForOperation(this.selectedFile.path);
    if (!frozen.ok) {
      this.appendLog(frozen.message);
      this.render();
      return;
    }

    let tempDirectory: string | undefined;
    try {
      tempDirectory = await mkdtemp(join(tmpdir(), "minipro-tui-verify-"));
      const verifyPath = join(tempDirectory, `${basename(this.selectedFile.path)}.confirmed.bin`);
      await writeFile(verifyPath, frozen.bytes);
      this.appendLog(`Verifying confirmed bytes: ${frozen.bytes.byteLength} B sha256 ${frozen.sha256}.`);
      await this.runConnectedAction("verify", buildVerifyArgs(this.selectedChip, verifyPath, this.advanced));
    } catch (error) {
      this.setJob({ kind: "failed", step: "verify", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async runConnectedAction(step: string, args: string[]): Promise<void> {
    this.setJob({ kind: "running", step: "detect programmer" });
    const detected = await this.runCommand(buildDetectProgrammerArgs(), true);
    const status = parseProgrammerStatus(`${detected.stdout}\n${detected.stderr}`);
    this.programmerStatus = status;
    if (detected.exitCode !== 0 || !status.connected) {
      this.setJob({ kind: "failed", step: "detect programmer", message: "No connected programmer detected." });
      return;
    }

    this.setJob({ kind: "running", step });
    const result = await this.runCommand(args, true);
    if (step === "pin/contact check" && isPinCheckUnsupported(commandText(result))) {
      this.setJob({ kind: "failed", step, message: "Pin/contact check is not supported for this programmer and chip." });
      return;
    }
    this.setJob(result.exitCode === 0 ? { kind: "done", message: `${step} completed.` } : { kind: "failed", step, message: result.stderr || result.stdout });
  }

  private async runCommand(args: string[], cancellable: boolean) {
    const controller = new AbortController();
    this.activeAbortController = controller;
    this.activeCommandCancellable = cancellable;
    this.render();
    try {
      return await this.executeCommand(args, { onLog: (line) => this.appendLog(line), signal: controller.signal });
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
    if (!this.selectedFile || !this.selectedChip || !this.chipInfo) {
      this.appendLog("Cannot write: select a file, select a chip, and load chip info first.");
      this.render();
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
        this.appendLog(`Cannot inspect backup destination: ${error instanceof Error ? error.message : String(error)}`);
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
      this.appendLog(frozen.message);
      this.render();
      return;
    }

    const preview = buildDefaultWritePreview(selectedChip, selectedFile.path, database, advanced, backupFile)
      .map((args) => JSON.stringify(["minipro", ...args]))
      .join("\n");
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
    const result = await runDefaultWriteWorkflow({
      file: selectedFile,
      chip: selectedChip,
      chipInfo,
      programmerKind: database,
      confirmed: true,
      confirmedBytes: frozen.bytes,
      confirmedSha256: frozen.sha256,
      backupFile,
      backupDestinationSnapshot,
      advanced,
      runCommand: (args, step) => {
        this.setJob({ kind: "running", step });
        return this.runCommand(args, step !== "erase" && step !== "write");
      },
      onLog: (line) => this.appendLog(line),
    }).catch((error) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error), steps: [] }));

    this.appendLog(result.message);
    this.setJob(result.ok ? { kind: "done", message: result.message } : { kind: "failed", step: "write flow", message: result.message });
  }

  private async readFlow(): Promise<void> {
    if (this.job.kind === "running") return;
    if (!this.selectedChip) {
      this.appendLog("Cannot read: select a chip first.");
      this.render();
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
      this.appendLog(`Cannot inspect read destination: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (destinationSnapshot.exists) {
      await this.dialogs.message("Read File Exists", "Choose a new output filename. Existing files are never replaced by a hardware read.");
      this.appendLog("Read cancelled to preserve the existing file.");
      return;
    }

    const confirmed = await this.dialogs.confirm(
      "Read Chip",
      [`Read ${selectedChip} to:`, outputFile, "", JSON.stringify(["minipro", ...buildReadArgs(selectedChip, outputFile, advanced)]), "", ...dangerousOptionWarnings(advanced)].join("\n"),
      "Read",
    );
    if (!confirmed) {
      this.appendLog("Read cancelled.");
      return;
    }

    this.setJob({ kind: "running", step: "read" });
    const result = await runReadWorkflow({
      chip: selectedChip,
      outputFile,
      destinationSnapshot,
      confirmed: true,
      advanced,
      runCommand: (args, step) => {
        this.setJob({ kind: "running", step });
        return this.runCommand(args, true);
      },
      onLog: (line) => this.appendLog(line),
    }).catch((error) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error), steps: [] }));

    this.appendLog(result.message);
    this.setJob(result.ok ? { kind: "done", message: result.message } : { kind: "failed", step: "read", message: result.message });
    if (result.ok) await this.refresh();
  }

  private async compareFlow(): Promise<void> {
    if (this.job.kind === "running") return;
    if (!this.selectedChip || !this.selectedFile) {
      this.appendLog("Cannot compare: select a chip and file first.");
      this.render();
      return;
    }
    const selectedChip = this.selectedChip;
    const selectedFile = this.selectedFile;
    const advanced = { ...this.advanced };

    const frozen = await freezeFileForOperation(selectedFile.path);
    if (!frozen.ok) {
      this.appendLog(frozen.message);
      this.render();
      return;
    }

    const confirmed = await this.dialogs.confirm(
      "Compare Chip",
      [
        `Compare ${basename(selectedFile.path)} with the current contents of ${selectedChip}.`,
        `Local file: ${frozen.bytes.byteLength} B sha256 ${frozen.sha256}`,
        "",
        JSON.stringify(["minipro", ...buildReadArgs(selectedChip, "<temp-compare-readback-file>", advanced)]),
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
    const result = await runCompareWorkflow({
      file: selectedFile,
      chip: selectedChip,
      confirmed: true,
      confirmedBytes: frozen.bytes,
      confirmedSha256: frozen.sha256,
      advanced,
      runCommand: (args, step) => {
        this.setJob({ kind: "running", step });
        return this.runCommand(args, true);
      },
      onLog: (line) => this.appendLog(line),
    }).catch((error) => ({ ok: false as const, message: error instanceof Error ? error.message : String(error), steps: [] }));

    this.appendLog(result.message);
    this.setJob(result.ok ? { kind: "done", message: result.message } : { kind: "failed", step: "compare", message: result.message });
    await this.dialogs.message("Compare Result", result.message);
  }

  private async advancedModal(): Promise<void> {
    const choice = await this.dialogs.select("Advanced Controls", [
      { name: `Show all files: ${this.showAllFiles ? "on" : "off"}`, description: "Toggle current-folder file filter", value: "all" },
      { name: `Pre-write backup: ${this.advanced.backupBeforeWrite ? "on" : "off"}`, description: "Read the current chip to a chosen file before erase", value: "backup" },
      { name: `Allow size mismatch: ${this.advanced.allowSizeMismatch ? "on" : "off"}`, description: "Dangerous: permits file/chip size mismatch", value: "s" },
      { name: `Disable readback compare: ${this.advanced.disableReadbackCompare ? "on" : "off"}`, description: "Dangerous: skips post-write byte compare", value: "r" },
      { name: `Skip explicit erase: ${this.advanced.skipErase ? "on" : "off"}`, description: "Only proceeds if the chip already passes blank check", value: "e" },
      { name: `Skip verify: ${this.advanced.skipVerify ? "on" : "off"}`, description: "Dangerous: skips verify", value: "v" },
      { name: `Ignore ID mismatch: ${this.advanced.ignoreIdMismatch ? "on" : "off"}`, description: "Dangerous: bypasses ID mismatch", value: "y" },
      { name: `Skip ID read: ${this.advanced.skipIdRead ? "on" : "off"}`, description: "Dangerous for read mode", value: "x" },
    ]);
    switch (choice?.value) {
      case "all":
        this.showAllFiles = !this.showAllFiles;
        this.queueStateSave();
        await this.refresh();
        return;
      case "s":
        this.advanced.allowSizeMismatch = !this.advanced.allowSizeMismatch;
        break;
      case "backup":
        this.advanced.backupBeforeWrite = !this.advanced.backupBeforeWrite;
        break;
      case "r":
        this.advanced.disableReadbackCompare = !this.advanced.disableReadbackCompare;
        break;
      case "e":
        this.advanced.skipErase = !this.advanced.skipErase;
        break;
      case "v":
        this.advanced.skipVerify = !this.advanced.skipVerify;
        break;
      case "y":
        this.advanced.ignoreIdMismatch = !this.advanced.ignoreIdMismatch;
        break;
      case "x":
        this.advanced.skipIdRead = !this.advanced.skipIdRead;
        break;
    }
    if (choice) {
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
        "  Tab        Move focus",
        "  Enter      Activate the selected item",
        "  F          Focus file search",
        "  E          Focus EPROM search",
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
      this.appendLog("Cannot show chip details: select a chip and load its info first.");
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
    for (const controller of this.activeCommandControllers) controller.abort();
    await Promise.allSettled([...this.activeCommandPromises]);
    this.queueStateSave();
    await this.stateSave;
    this.renderer?.destroy();
    if (this.options.exit) this.options.exit(0);
    else process.exit(0);
  }

  private startOperation(operation: () => Promise<void>): void {
    if (this.operationPending || this.job.kind === "running") return;
    this.operationPending = true;
    this.chipSearchAbortController?.abort();
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
      this.compactMode = true;
      this.setCompactPanel(this.compactPanel);
    } else {
      for (const child of components.compactContent.getChildren()) components.compactContent.remove(child);
      if (components.compactTabs.parent === components.main) components.main.remove(components.compactTabs);
      if (components.compactContent.parent === components.main) components.main.remove(components.compactContent);

      for (const panel of [components.filesPanel, components.chipPanel, components.statusPanel]) {
        panel.parent?.remove(panel);
        panel.width = "auto";
        panel.flexGrow = 1;
        panel.flexBasis = 0;
        panel.marginBottom = 0;
      }
      components.filesPanel.marginRight = 1;
      components.chipPanel.marginRight = 1;
      components.statusPanel.marginRight = 0;
      components.topRow.add(components.filesPanel);
      components.topRow.add(components.chipPanel);
      components.topRow.add(components.statusPanel);
      components.main.insertBefore(components.topRow, components.footerBox);
      components.main.insertBefore(components.logPanel, components.footerBox);
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

  private focusNext(): void {
    const focusables = this.focusableControls();
    const current = focusables.findIndex((item) => item.focused);
    focusables[(current + 1) % focusables.length]?.focus();
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

  private appendLog(line: string): void {
    for (const part of line.split(/\r?\n|\r/)) {
      const sanitized = sanitizeLogLine(part);
      if (sanitized.trim()) this.logLines.push(sanitized);
    }
    if (this.logLines.length > LOG_LINE_LIMIT) this.logLines.splice(0, this.logLines.length - LOG_LINE_LIMIT);
    this.render();
  }

  private render(): void {
    if (!this.components || this.shuttingDown) return;
    const focus = this.focusLabel();
    this.statusLine = `${formatStatusLine({
      programmerStatus: this.programmerStatus,
      database: this.database,
      selectedChip: this.selectedChip,
      selectedFile: this.selectedFile,
      job: this.job,
    })} | Focus ${focus}`;
    this.components.statusBarBox.backgroundColor = this.programmerStatus.connected ? CONNECTED : DISCONNECTED;
    const filteredFileEntries = filterFileTreeEntries(this.fileTreeEntries, this.fileQuery, this.fileDirectory);
    const visibleFileEntries = this.fileQuery.trim() ? filteredFileEntries : orderFileTreeEntries(filteredFileEntries, this.recentFilePaths, this.recentDirectories);
    const fileOptions = visibleFileEntries.length > 0
      ? visibleFileEntries.map((entry) => formatFileTreeDisplayOption(entry, this.selectedFile?.path, this.recentFilePaths, this.recentDirectories))
      : [formatFileEmptyOption(this.fileDirectory, this.fileQuery, this.showAllFiles)];
    this.updateSelectOptions(this.components.files, fileOptions, visibleFileEntries.length > 0 ? visibleFileEntries.map(formatFileTreeOptionKey).join("\n") : "<no-files>");
    this.setSelectedIndex(this.components.files, fileOptions.findIndex((option) => option.value === this.selectedFile?.path));
    const visibleChips = orderByRecents(this.chipResults, this.recentChips);
    const chipOptions = visibleChips.length > 0 ? formatChipOptions(visibleChips, this.chipInfoCache, this.selectedChip, this.recentChips) : [formatChipEmptyOption(this.chipQuery)];
    this.updateSelectOptions(this.components.chips, chipOptions, visibleChips.length > 0 ? visibleChips.map((chip) => `${chip}:${chip === this.selectedChip}:${this.recentChips.includes(chip)}:${this.chipInfoCache.get(chip)?.raw ?? ""}`).join("\n") : "<no-chips>");
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
    this.footerLine = this.activeCommandCancellable ? `[Esc] cancel  ${footerText()}` : footerText();
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
    setPanelFocus(components.statusPanel, "Status", false);
    setPanelFocus(components.logPanel, "Actions / Log", focus === "Log");
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

  private async executeCommand(args: string[], options: Parameters<typeof runMinipro>[1] = {}) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.activeCommandControllers.add(controller);
    const promise = Promise.resolve().then(() => (this.options.commandRunner ?? runMinipro)(args, { ...options, signal: controller.signal }));
    this.activeCommandPromises.add(promise);
    try {
      return await promise;
    } finally {
      options.signal?.removeEventListener("abort", forwardAbort);
      this.activeCommandControllers.delete(controller);
      this.activeCommandPromises.delete(promise);
    }
  }

  private requireRenderer(): CliRenderer {
    if (!this.renderer) throw new Error("Renderer is not initialized.");
    return this.renderer;
  }

  private requireComponents(): Components {
    if (!this.components) throw new Error("Components are not initialized.");
    return this.components;
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
    titleColor: PRIMARY,
    border: true,
    borderStyle: "rounded",
    borderColor: BORDER,
    focusedBorderColor: PRIMARY,
    backgroundColor: PANEL,
    padding: 1,
    flexGrow: 1,
    flexBasis: 0,
    flexDirection: "column",
  });
}

function lineBox(renderer: CliRenderer, id: string, backgroundColor: string, getText: () => string, height = 1): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    height,
    width: "100%",
    backgroundColor,
    padding: 0,
    renderAfter: function (buffer) {
      buffer.drawText(truncateEnd(getText(), Math.max(0, this.width)), this.screenX, this.screenY + this.height - 1, CHROME_FG);
    },
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

function footerText(): string {
  return "[Tab] focus  [Enter] select  [F] files  [E] EPROMs  [W] write  [Shift+R] read  [M] compare  [?] help  [Q] quit";
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
  const seen = new Set<string>();
  const ordered: string[] = [];
  const preferred = query === DEFAULT_CHIP_QUERY ? [DEFAULT_CHIP_QUERY, SECONDARY_DEFAULT_CHIP] : chips.filter((chip) => chip === DEFAULT_CHIP_QUERY || chip === SECONDARY_DEFAULT_CHIP);

  for (const chip of [...preferred, ...chips]) {
    if (seen.has(chip)) continue;
    seen.add(chip);
    ordered.push(chip);
  }

  return ordered;
}

function formatChipOptions(chips: string[], infoByChip: Map<string, ChipInfo>, selectedChip: string | undefined, recentChips: string[]): SelectOption[] {
  return chips.map((chip) => {
    const option = formatChipLabel(chip, infoByChip.get(chip));
    const current = chip === selectedChip;
    const recent = recentChips.includes(chip);
    return {
      ...option,
      name: formatCurrentName(option.name, current),
      description: formatRecentDescription(recent, current, option.description),
    };
  });
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
  panel.titleColor = focused ? TEXT : PRIMARY;
  panel.borderStyle = focused ? "heavy" : "rounded";
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
  return value === "tl866a" || value === "tl866ii" || value === "t48" || value === "t56";
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

function commandText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function isPinCheckUnsupported(output: string): boolean {
  return /pin test is not supported|pin.*check.*not supported/i.test(output);
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
