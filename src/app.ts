import { readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  RenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core";

import type { AdvancedOptions, ChipInfo, FileEntry, FileTreeEntry, JobState, ProgrammerDatabase, ProgrammerKind, ProgrammerStatus } from "./types";
import { sha256Bytes } from "./files/hash";
import { isFileEntry, scanFileTree } from "./files/scan";
import {
  buildBlankCheckArgs,
  buildDefaultWritePreview,
  buildPinCheckArgs,
  buildVerifyArgs,
  buildSearchChipsArgs,
  buildChipInfoArgs,
  buildReadArgs,
  runMinipro,
} from "./minipro/commands";
import { parseChipInfo, parseChipSearch, parseProgrammerDatabases, parseProgrammerStatus } from "./minipro/parse";
import { runCompareWorkflow, runDefaultWriteWorkflow, runReadWorkflow } from "./minipro/workflow";
import { DEFAULT_ADVANCED_OPTIONS, dangerousOptionWarnings, hasDangerousOptions } from "./safety/options";
import { DialogController } from "./tui/dialogs";
import { formatChipLabel, formatFileTreeOption, formatLogContent, formatStatusLine, formatStatusSummaryContent, sanitizeLogLine } from "./tui/render";

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
const RECENT_LIMIT = 8;

type Components = {
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
  log: TextRenderable;
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
  private fileOptionsKey = "";
  private chipOptionsKey = "";
  private statusLine = "";
  private footerLine = footerText();
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
      this.restoreFocusAfterModal = this.captureFocusedControl();
      this.modalActive = true;
    },
    onClose: () => {
      this.modalActive = false;
      this.restoreFocusAfterModal?.();
      this.restoreFocusAfterModal = undefined;
      this.render();
    },
  });

  async start(): Promise<void> {
    this.renderer = await createCliRenderer({
      exitOnCtrlC: false,
      consoleMode: "disabled",
      backgroundColor: BG,
    });
    this.components = this.createLayout(this.renderer);
    this.bindKeys(this.renderer, this.components);
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
    });

    const topRow = new BoxRenderable(renderer, { id: "top-row", height: "33%", width: "100%", flexDirection: "row", marginBottom: 1 });
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
    const log = new TextRenderable(renderer, { id: "log", width: "100%", height: "100%", fg: TEXT, bg: PANEL, wrapMode: "word" });
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

    return { statusBarBox, filesPanel, fileQuery, files, chipPanel, chipQuery, chips, statusPanel, statusSummary, logPanel, log, footerBox };
  }

  private bindKeys(renderer: CliRenderer, components: Components): void {
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (this.modalActive) return;

      if (key.ctrl && key.name === "c") {
        void this.quit();
        return;
      }

      if (components.fileQuery.focused || components.chipQuery.focused) {
        if (key.name === "tab") this.focusNext();
        return;
      }

      if (key.name === "q") {
        void this.quit();
        return;
      }

      if (key.name === "tab") {
        this.focusNext();
        return;
      }

      if (key.name === "/") {
        void this.searchChip(components.chipQuery.value.trim() || this.chipQuery || DEFAULT_CHIP_QUERY, false, true);
        return;
      }

      if (key.name === "f") {
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
        void this.readFlow();
        return;
      }

      switch (key.name) {
        case "r":
          void this.refresh();
          break;
        case "p":
          void this.pickProgrammerDatabase();
          break;
        case "c":
          void this.singleChipAction("pin/contact check", buildPinCheckArgs);
          break;
        case "b":
          void this.singleChipAction("blank check", buildBlankCheckArgs);
          break;
        case "v":
          void this.verifySelectedFile();
          break;
        case "m":
          void this.compareFlow();
          break;
        case "w":
          void this.writeFlow();
          break;
        case "a":
          void this.advancedModal();
          break;
        case "l":
          void this.dialogs.message("Full Log", this.logLines.join("\n") || "No log output yet.");
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

    for (const focusable of [components.fileQuery, components.files, components.chipQuery, components.chips]) {
      focusable.on(RenderableEvents.FOCUSED, () => this.render());
      focusable.on(RenderableEvents.BLURRED, () => this.render());
    }
  }

  private async refresh(): Promise<void> {
    if (this.job.kind === "running") return;
    this.appendLog("Refreshing files and programmer status.");

    await this.refreshFiles();

    const databases = await runMinipro(["-Q"], { onLog: (line) => this.appendLog(line) });
    this.programmerDatabases = parseProgrammerDatabases(databases.stdout);
    if (this.programmerDatabases.length > 0) {
      this.appendLog(`Available programmer databases: ${this.programmerDatabases.map((db) => db.kind).join(", ")}`);
    }

    const status = await runMinipro(["-k"], { onLog: (line) => this.appendLog(line) });
    this.programmerStatus = parseProgrammerStatus(`${status.stdout}\n${status.stderr}`);
    if (this.programmerStatus.kind && this.programmerStatus.kind !== this.database) {
      this.database = this.programmerStatus.kind;
      this.chipInfoCache.clear();
    }
    this.job = { kind: "idle" };
    this.render();
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
    const requestId = ++this.chipSearchRequestId;
    const database = this.database;
    this.chipQuery = query;
    const components = this.requireComponents();
    components.chipQuery.value = query;
    this.appendLog(`Searching ${database} database for ${query}.`);
    const result = await runMinipro(buildSearchChipsArgs(database, query), { onLog: (line) => this.appendLog(line) });
    if (requestId !== this.chipSearchRequestId || this.database !== database || this.chipQuery !== query) return;
    this.chipResults = orderChipResults(result.exitCode === 0 ? parseChipSearch(result.stdout) : [], query);

    await this.prefetchChipInfo(this.chipResults.slice(0, CHIP_INFO_PREFETCH_LIMIT), database);
    if (requestId !== this.chipSearchRequestId || this.database !== database || this.chipQuery !== query) return;

    const defaultChip = preferDefault ? this.chipResults.find((chip) => chip === DEFAULT_CHIP_QUERY) : undefined;
    this.selectedChip = defaultChip;
    this.chipInfo = undefined;
    if (focusResults) components.chips.focus();
    this.render();

    if (defaultChip) await this.selectChip(defaultChip);
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
      this.appendLog(`Selected file ${file.name} (${file.size} B, ${file.sha256Short}).`);
    } else if (changed) this.render();
  }

  private async openFileDirectory(path: string): Promise<void> {
    this.fileDirectory = path === ".." ? resolve(this.fileDirectory, "..") : path;
    this.recentDirectories = rememberRecent(this.recentDirectories, this.fileDirectory);
    this.fileQuery = "";
    this.requireComponents().fileQuery.value = "";
    this.appendLog(`Browsing files in ${this.fileDirectory}.`);
    await this.refreshFiles();
    this.render();
  }

  private async selectChip(chip: string): Promise<void> {
    if (!chip || this.job.kind === "running") return;
    const requestId = ++this.chipInfoRequestId;
    const database = this.database;
    this.selectedChip = chip;
    this.chipInfo = undefined;
    this.recentChips = rememberRecent(this.recentChips, chip);
    this.appendLog(`Loading chip info for ${chip}.`);
    this.render();
    const result = await runMinipro(buildChipInfoArgs(database, chip), { onLog: (line) => this.appendLog(line) });
    if (requestId !== this.chipInfoRequestId || this.database !== database || this.selectedChip !== chip) return;
    this.chipInfo = parseChipInfo(result.stdout);
    if (!this.chipInfo.name) this.chipInfo.name = chip;
    if (this.chipInfo.raw.trim()) this.chipInfoCache.set(chip, this.chipInfo);
    this.render();
  }

  private async prefetchChipInfo(chips: string[], database: ProgrammerKind): Promise<void> {
    const missing = chips.filter((chip) => !this.chipInfoCache.has(chip));
    await Promise.all(
      missing.map(async (chip) => {
        const result = await runMinipro(buildChipInfoArgs(database, chip));
        if (this.database !== database || result.exitCode !== 0 || !result.stdout.trim()) return;
        const info = parseChipInfo(result.stdout);
        if (!info.name) info.name = chip;
        this.chipInfoCache.set(chip, info);
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
    this.setJob({ kind: "running", step });
    const result = await runMinipro(buildArgs(this.selectedChip, this.advanced), { onLog: (line) => this.appendLog(line) });
    this.setJob(result.exitCode === 0 ? { kind: "done", message: `${step} completed.` } : { kind: "failed", step, message: result.stderr || result.stdout });
  }

  private async verifySelectedFile(): Promise<void> {
    if (this.job.kind === "running") return;
    if (!this.selectedChip || !this.selectedFile) {
      this.appendLog("Cannot verify: select a chip and file first.");
      this.render();
      return;
    }
    this.setJob({ kind: "running", step: "verify" });
    const result = await runMinipro(buildVerifyArgs(this.selectedChip, this.selectedFile.path, this.advanced), { onLog: (line) => this.appendLog(line) });
    this.setJob(result.exitCode === 0 ? { kind: "done", message: "Verify completed." } : { kind: "failed", step: "verify", message: result.stderr || result.stdout });
  }

  private async writeFlow(): Promise<void> {
    if (this.job.kind === "running") return;
    if (!this.selectedFile || !this.selectedChip || !this.chipInfo) {
      this.appendLog("Cannot write: select a file, select a chip, and load chip info first.");
      this.render();
      return;
    }

    const frozen = await freezeFileForOperation(this.selectedFile.path);
    if (!frozen.ok) {
      this.appendLog(frozen.message);
      this.render();
      return;
    }

    const preview = buildDefaultWritePreview(this.selectedChip, this.selectedFile.path, this.database, this.advanced)
      .map((args) => JSON.stringify(["minipro", ...args]))
      .join("\n");
    const confirmed = await this.dialogs.confirm(
      "Write Chip",
      [
        `This will check, erase, write, verify, and read back ${basename(this.selectedFile.path)} to ${this.selectedChip}.`,
        `Confirmed bytes: ${frozen.bytes.byteLength} B sha256 ${frozen.sha256}`,
        "",
        preview,
        "",
        ...dangerousOptionWarnings(this.advanced),
      ].join("\n"),
      "Write",
    );
    if (!confirmed) {
      this.appendLog("Write flow cancelled.");
      return;
    }

    if (hasDangerousOptions(this.advanced)) {
      const confirmDanger = await this.dialogs.confirm("Dangerous Options", dangerousOptionWarnings(this.advanced).join("\n"), "Continue");
      if (!confirmDanger) {
        this.appendLog("Write flow cancelled because dangerous options were not confirmed.");
        return;
      }
    }

    this.setJob({ kind: "running", step: "write flow" });
    const result = await runDefaultWriteWorkflow({
      file: this.selectedFile,
      chip: this.selectedChip,
      chipInfo: this.chipInfo,
      programmerKind: this.database,
      confirmed: true,
      confirmedBytes: frozen.bytes,
      confirmedSha256: frozen.sha256,
      advanced: this.advanced,
      runCommand: (args, step) => {
        this.setJob({ kind: "running", step });
        return runMinipro(args, { onLog: (line) => this.appendLog(line) });
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

    const outputFile = await this.dialogs.filename("Read Chip", join(this.fileDirectory, defaultReadFilename(this.selectedChip)));
    if (!outputFile) {
      this.appendLog("Read cancelled.");
      return;
    }

    if (await fileExists(outputFile)) {
      const overwrite = await this.dialogs.confirm("Overwrite File", `${outputFile} already exists. Overwrite it?`, "Overwrite");
      if (!overwrite) {
        this.appendLog("Read cancelled to avoid overwriting an existing file.");
        return;
      }
    }

    const confirmed = await this.dialogs.confirm(
      "Read Chip",
      [`Read ${this.selectedChip} to:`, outputFile, "", JSON.stringify(["minipro", ...buildReadArgs(this.selectedChip, outputFile, this.advanced)]), "", ...dangerousOptionWarnings(this.advanced)].join("\n"),
      "Read",
    );
    if (!confirmed) {
      this.appendLog("Read cancelled.");
      return;
    }

    this.setJob({ kind: "running", step: "read" });
    const result = await runReadWorkflow({
      chip: this.selectedChip,
      outputFile,
      confirmed: true,
      advanced: this.advanced,
      runCommand: (args, step) => {
        this.setJob({ kind: "running", step });
        return runMinipro(args, { onLog: (line) => this.appendLog(line) });
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

    const frozen = await freezeFileForOperation(this.selectedFile.path);
    if (!frozen.ok) {
      this.appendLog(frozen.message);
      this.render();
      return;
    }

    const confirmed = await this.dialogs.confirm(
      "Compare Chip",
      [
        `Compare ${basename(this.selectedFile.path)} with the current contents of ${this.selectedChip}.`,
        `Local file: ${frozen.bytes.byteLength} B sha256 ${frozen.sha256}`,
        "",
        JSON.stringify(["minipro", ...buildReadArgs(this.selectedChip, "<temp-compare-readback-file>", this.advanced)]),
        "",
        ...dangerousOptionWarnings(this.advanced),
      ].join("\n"),
      "Compare",
    );
    if (!confirmed) {
      this.appendLog("Compare cancelled.");
      return;
    }

    this.setJob({ kind: "running", step: "compare" });
    const result = await runCompareWorkflow({
      file: this.selectedFile,
      chip: this.selectedChip,
      confirmed: true,
      confirmedBytes: frozen.bytes,
      confirmedSha256: frozen.sha256,
      advanced: this.advanced,
      runCommand: (args, step) => {
        this.setJob({ kind: "running", step });
        return runMinipro(args, { onLog: (line) => this.appendLog(line) });
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
      { name: `Allow size mismatch: ${this.advanced.allowSizeMismatch ? "on" : "off"}`, description: "Dangerous: permits file/chip size mismatch", value: "s" },
      { name: `Disable readback compare: ${this.advanced.disableReadbackCompare ? "on" : "off"}`, description: "Dangerous: skips post-write byte compare", value: "r" },
      { name: `Skip erase: ${this.advanced.skipErase ? "on" : "off"}`, description: "Dangerous: old contents may remain", value: "e" },
      { name: `Skip verify: ${this.advanced.skipVerify ? "on" : "off"}`, description: "Dangerous: skips verify", value: "v" },
      { name: `Ignore ID mismatch: ${this.advanced.ignoreIdMismatch ? "on" : "off"}`, description: "Dangerous: bypasses ID mismatch", value: "y" },
      { name: `Skip ID read: ${this.advanced.skipIdRead ? "on" : "off"}`, description: "Dangerous for read mode", value: "x" },
    ]);
    switch (choice?.value) {
      case "all":
        this.showAllFiles = !this.showAllFiles;
        await this.refresh();
        return;
      case "s":
        this.advanced.allowSizeMismatch = !this.advanced.allowSizeMismatch;
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
    if (choice) this.appendLog(`Advanced options: ${JSON.stringify(this.advanced)}`);
    this.render();
  }

  private async help(): Promise<void> {
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
  }

  private async quit(): Promise<void> {
    if (this.job.kind === "running") {
      await this.dialogs.message("Job Running", "A hardware command is running. Quit is disabled until the command exits.");
      return;
    }
    this.renderer?.destroy();
    process.exit(0);
  }

  private focusNext(): void {
    const components = this.requireComponents();
    const focusables = [components.fileQuery, components.files, components.chipQuery, components.chips];
    const current = focusables.findIndex((item) => item.focused);
    focusables[(current + 1) % focusables.length]?.focus();
    this.render();
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
    this.render();
  }

  private render(): void {
    if (!this.components) return;
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
    this.components.log.content = formatLogContent(this.logLines.slice(-120));
    this.components.log.scrollY = this.components.log.maxScrollY;
    this.footerLine = footerText();
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
    return "Dialog";
  }

  private renderFocusState(focus: string): void {
    const components = this.requireComponents();
    setPanelFocus(components.filesPanel, `Files ${formatDirectoryLabel(this.fileDirectory)}`, focus === "File Search" || focus === "Files");
    setPanelFocus(components.chipPanel, "Chip Search", focus === "Chip Search" || focus === "Chip Results");
    setPanelFocus(components.statusPanel, "Status", false);
    setPanelFocus(components.logPanel, "Actions / Log", false);
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
    for (const control of [components.fileQuery, components.files, components.chipQuery, components.chips]) {
      if (control.focused) return () => control.focus();
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
    borderStyle: "single",
    borderColor: BORDER,
    focusedBorderColor: BORDER_ACTIVE,
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
    wrapSelection: true,
  };
}

function footerText(): string {
  return "q quit | tab focus | enter/space select | f files | / chips | r refresh | w write | m compare | R read | ? help";
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

function setPanelFocus(panel: BoxRenderable, title: string, focused: boolean): void {
  panel.title = focused ? ` > ${title} ` : ` ${title} `;
  panel.titleColor = focused ? TEXT : PRIMARY;
  panel.borderColor = focused ? PRIMARY : BORDER;
}

function isProgrammerKind(value: string): value is ProgrammerKind {
  return value === "tl866a" || value === "tl866ii" || value === "t48" || value === "t56";
}

function defaultReadFilename(chip: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
  return `${sanitizeFilename(chip)}-${stamp}.bin`;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "readback";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function freezeFileForOperation(path: string): Promise<{ ok: true; bytes: Uint8Array; sha256: string } | { ok: false; message: string }> {
  try {
    const before = await stat(path);
    const bytes = await readFile(path);
    const after = await stat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return { ok: false, message: "Selected file changed while preparing the operation. Refresh and reselect it before continuing." };
    }
    return { ok: true, bytes, sha256: sha256Bytes(bytes) };
  } catch (error) {
    return { ok: false, message: `Cannot read selected file before confirmation: ${error instanceof Error ? error.message : String(error)}` };
  }
}
