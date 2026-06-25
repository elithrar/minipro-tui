import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

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

import type { AdvancedOptions, ChipInfo, FileEntry, JobState, ProgrammerDatabase, ProgrammerKind, ProgrammerStatus } from "./types";
import { sha256Bytes } from "./files/hash";
import { scanFiles } from "./files/scan";
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
import { formatChipLabel, formatFileOption, formatLogContent, formatStatusLine, formatStatusSummary, sanitizeLogLine } from "./tui/render";

const PRIMARY = "#fab283";
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

type Components = {
  statusBarBox: BoxRenderable;
  filesPanel: BoxRenderable;
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
  private files: FileEntry[] = [];
  private chipQuery = DEFAULT_CHIP_QUERY;
  private chipResults: string[] = [];
  private chipInfoCache = new Map<string, ChipInfo>();
  private selectedFile: FileEntry | undefined;
  private selectedChip: string | undefined;
  private chipInfo: ChipInfo | undefined;
  private job: JobState = { kind: "idle" };
  private logLines: string[] = [];
  private showAllFiles = false;
  private advanced: AdvancedOptions = { ...DEFAULT_ADVANCED_OPTIONS };
  private modalActive = false;
  private fileOptionsKey = "";
  private chipOptionsKey = "";
  private statusLine = "";
  private footerLine = footerText();

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

    const statusBarBox = lineBox(renderer, "status-bar-box", DISCONNECTED, () => this.statusLine);

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
    filesPanel.padding = 0;
    const files = new SelectRenderable(renderer, selectOptions("files", "100%"));
    filesPanel.add(files);

    const chipPanel = panel(renderer, "chip-panel", "Chip Search");
    chipPanel.marginRight = 1;
    chipPanel.padding = 0;
    const chipQuery = new InputRenderable(renderer, {
      id: "chip-query",
      value: DEFAULT_CHIP_QUERY,
      placeholder: "AT28C64B",
      width: "100%",
      backgroundColor: ELEMENT,
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
    statusPanel.padding = 0;
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
    root.add(statusBarBox);
    root.add(main);
    root.add(footerBox);
    renderer.root.add(root);
    files.focus();

    return { statusBarBox, filesPanel, files, chipPanel, chipQuery, chips, statusPanel, statusSummary, logPanel, log, footerBox };
  }

  private bindKeys(renderer: CliRenderer, components: Components): void {
    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (this.modalActive) return;

      if (key.ctrl && key.name === "c") {
        void this.quit();
        return;
      }

      if (components.chipQuery.focused) {
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
        components.files.focus();
        this.render();
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
          void this.message("Full Log", this.logLines.join("\n") || "No log output yet.");
          break;
        case "?":
          void this.help();
          break;
      }
    });

    components.chipQuery.on(InputRenderableEvents.ENTER, (value: string) => {
      void this.searchChip(value.trim() || DEFAULT_CHIP_QUERY, false, true);
    });

    components.files.on(SelectRenderableEvents.SELECTION_CHANGED, (_index: number, option: SelectOption | null) => {
      this.selectFileByPath(String(option?.value ?? ""));
    });

    components.files.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
      this.selectFileByPath(String(option.value ?? ""), true);
    });

    components.chips.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
      void this.selectChip(String(option.value ?? option.name));
    });

    for (const focusable of [components.files, components.chipQuery, components.chips]) {
      focusable.on(RenderableEvents.FOCUSED, () => this.render());
      focusable.on(RenderableEvents.BLURRED, () => this.render());
    }
  }

  private async refresh(): Promise<void> {
    if (this.job.kind === "running") return;
    this.appendLog("Refreshing files and programmer status.");

    this.files = await scanFiles(process.cwd(), this.showAllFiles);
    const selectedPath = this.selectedFile?.path;
    this.selectedFile = selectedPath ? this.files.find((entry) => entry.path === selectedPath) : undefined;
    if (!this.selectedFile && this.files.length > 0) this.selectedFile = this.files[0];

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

  private async searchChip(query: string, preferDefault: boolean, focusResults = false): Promise<void> {
    if (this.job.kind === "running") return;
    this.chipQuery = query;
    const components = this.requireComponents();
    components.chipQuery.value = query;
    this.appendLog(`Searching ${this.database} database for ${query}.`);
    const result = await runMinipro(buildSearchChipsArgs(this.database, query), { onLog: (line) => this.appendLog(line) });
    this.chipResults = orderChipResults(result.exitCode === 0 ? parseChipSearch(result.stdout) : [], query);

    await this.prefetchChipInfo(this.chipResults.slice(0, CHIP_INFO_PREFETCH_LIMIT));

    const defaultChip = preferDefault ? this.chipResults.find((chip) => chip === DEFAULT_CHIP_QUERY) : undefined;
    this.selectedChip = defaultChip;
    this.chipInfo = undefined;
    if (focusResults) components.chips.focus();
    this.render();

    if (defaultChip) await this.selectChip(defaultChip);
  }

  private selectFileByPath(path: string, logSelection = false): void {
    const file = this.files.find((entry) => entry.path === path);
    if (!file) return;
    const changed = this.selectedFile?.path !== file.path;
    this.selectedFile = file;
    if (logSelection) this.appendLog(`Selected file ${file.name} (${file.size} B, ${file.sha256Short}).`);
    else if (changed) this.render();
  }

  private async selectChip(chip: string): Promise<void> {
    if (!chip || this.job.kind === "running") return;
    this.selectedChip = chip;
    this.appendLog(`Loading chip info for ${chip}.`);
    const result = await runMinipro(buildChipInfoArgs(this.database, chip), { onLog: (line) => this.appendLog(line) });
    this.chipInfo = parseChipInfo(result.stdout);
    if (!this.chipInfo.name) this.chipInfo.name = chip;
    if (this.chipInfo.raw.trim()) this.chipInfoCache.set(chip, this.chipInfo);
    this.render();
  }

  private async prefetchChipInfo(chips: string[]): Promise<void> {
    const missing = chips.filter((chip) => !this.chipInfoCache.has(chip));
    await Promise.all(
      missing.map(async (chip) => {
        const result = await runMinipro(buildChipInfoArgs(this.database, chip));
        if (result.exitCode !== 0 || !result.stdout.trim()) return;
        const info = parseChipInfo(result.stdout);
        if (!info.name) info.name = chip;
        this.chipInfoCache.set(chip, info);
      }),
    );
  }

  private async pickProgrammerDatabase(): Promise<void> {
    if (this.job.kind === "running") return;
    const kinds = this.programmerDatabases.length > 0 ? this.programmerDatabases.map((db) => db.kind) : ["tl866a", "tl866ii", "t48", "t56"];
    const choice = await this.selectDialog(
      "Programmer Database",
      kinds.map((kind) => ({ name: kind, description: kind === this.database ? "current" : "", value: kind })),
      kinds.indexOf(this.database),
    );
    if (!choice || !isProgrammerKind(String(choice.value))) return;
    this.database = String(choice.value) as ProgrammerKind;
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
    const confirmed = await this.confirmDialog(
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
      const confirmDanger = await this.confirmDialog("Dangerous Options", dangerousOptionWarnings(this.advanced).join("\n"), "Continue");
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

    const outputFile = await this.filenameDialog("Read Chip", defaultReadFilename(this.selectedChip));
    if (!outputFile) {
      this.appendLog("Read cancelled.");
      return;
    }

    if (await fileExists(outputFile)) {
      const overwrite = await this.confirmDialog("Overwrite File", `${outputFile} already exists. Overwrite it?`, "Overwrite");
      if (!overwrite) {
        this.appendLog("Read cancelled to avoid overwriting an existing file.");
        return;
      }
    }

    const confirmed = await this.confirmDialog(
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

    const confirmed = await this.confirmDialog(
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
    await this.message("Compare Result", result.message);
  }

  private async advancedModal(): Promise<void> {
    const choice = await this.selectDialog("Advanced Controls", [
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
    await this.message(
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
      await this.message("Job Running", "A hardware command is running. Quit is disabled until the command exits.");
      return;
    }
    this.renderer?.destroy();
    process.exit(0);
  }

  private async confirmDialog(title: string, content: string, confirmLabel: string): Promise<boolean> {
    const renderer = this.requireRenderer();
    this.modalActive = true;
    const maxHeight = maxModalHeight(renderer);
    const textHeight = clamp(estimateWrappedRows(content, modalInnerWidth(renderer)), 3, Math.max(3, maxHeight - 8));
    const modal = modalBox(renderer, title, textHeight + 8);
    modal.add(new TextRenderable(renderer, { content, width: "100%", height: textHeight, fg: TEXT, bg: PANEL, wrapMode: "word", marginBottom: 1 }));
    const buttons = new SelectRenderable(renderer, {
      ...selectOptions("confirm-buttons", 4),
      options: [
        { name: "Cancel", description: "Return without continuing", value: "cancel" },
        { name: confirmLabel, description: "Continue with this action", value: "confirm" },
      ],
      selectedIndex: 0,
    });
    modal.add(buttons);
    modal.add(new TextRenderable(renderer, { content: "Enter = Choose    Esc/q = Cancel", width: "100%", height: 1, fg: MUTED, bg: PANEL, marginTop: 1 }));
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      const done = (value: boolean) => {
        buttons.onKeyDown = undefined;
        buttons.off(SelectRenderableEvents.ITEM_SELECTED, selected);
        renderer.root.remove(modal.id);
        this.modalActive = false;
        this.render();
        resolve(value);
      };
      const selected = (_index: number, option: SelectOption) => done(option.value === "confirm");
      const handler = (key: KeyEvent) => {
        if (isCancelKey(key) || isKey(key, "q") || isKey(key, "n")) {
          key.preventDefault();
          key.stopPropagation();
          done(false);
          return;
        }
      };
      buttons.on(SelectRenderableEvents.ITEM_SELECTED, selected);
      buttons.onKeyDown = handler;
      buttons.focus();
    });
  }

  private async filenameDialog(title: string, initialValue: string): Promise<string | undefined> {
    const renderer = this.requireRenderer();
    this.modalActive = true;
    const modal = modalBox(renderer, title, 9);
    modal.add(new TextRenderable(renderer, { content: "Output filename:", width: "100%", height: 1, fg: MUTED, bg: PANEL }));
    const input = new InputRenderable(renderer, {
      value: initialValue,
      width: "100%",
      backgroundColor: ELEMENT,
      focusedBackgroundColor: ELEMENT_FOCUSED,
      textColor: TEXT,
      cursorColor: PRIMARY,
      marginTop: 1,
      marginBottom: 1,
    });
    modal.add(input);
    modal.add(new TextRenderable(renderer, { content: "Enter = Read    Esc = Cancel", width: "100%", height: 1, fg: MUTED, bg: PANEL }));
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      const done = (value: string | undefined) => {
        input.onKeyDown = undefined;
        input.off(InputRenderableEvents.ENTER, submit);
        renderer.root.remove(modal.id);
        this.modalActive = false;
        this.render();
        resolve(value);
      };
      const submit = (value: string) => done(value.trim() || undefined);
      const handler = (key: KeyEvent) => {
        if (isCancelKey(key)) {
          key.preventDefault();
          key.stopPropagation();
          done(undefined);
          return;
        }
      };
      input.on(InputRenderableEvents.ENTER, submit);
      input.onKeyDown = handler;
      setTimeout(() => {
        input.focus();
        renderer.root.requestRender();
      }, 0);
    });
  }

  private async selectDialog(title: string, options: SelectOption[], selectedIndex = 0): Promise<SelectOption | undefined> {
    const renderer = this.requireRenderer();
    this.modalActive = true;
    const rowsPerOption = options.some((option) => option.description) ? 2 : 1;
    const desiredSelectHeight = Math.max(4, options.length * rowsPerOption);
    const modalHeight = clamp(desiredSelectHeight + 7, 10, maxModalHeight(renderer));
    const modal = modalBox(renderer, title, modalHeight);
    const select = new SelectRenderable(renderer, {
      ...selectOptions("modal-select", Math.max(4, modalHeight - 7)),
      options,
      selectedIndex: Math.max(0, selectedIndex),
    });
    modal.add(select);
    modal.add(new TextRenderable(renderer, { content: "Enter = Select    Esc/q = Cancel", width: "100%", height: 1, fg: MUTED, bg: PANEL, marginTop: 1 }));
    renderer.root.add(modal);

    return new Promise((resolve) => {
      const done = (value: SelectOption | undefined) => {
        select.onKeyDown = undefined;
        select.off(SelectRenderableEvents.ITEM_SELECTED, selected);
        renderer.root.remove(modal.id);
        this.modalActive = false;
        this.render();
        resolve(value);
      };
      const selected = (_index: number, option: SelectOption) => done(option);
      const handler = (key: KeyEvent) => {
        if (isCancelKey(key) || isKey(key, "q")) {
          key.preventDefault();
          key.stopPropagation();
          done(undefined);
          return;
        }
      };
      select.on(SelectRenderableEvents.ITEM_SELECTED, selected);
      select.onKeyDown = handler;
      select.focus();
    });
  }

  private async message(title: string, content: string): Promise<void> {
    const renderer = this.requireRenderer();
    this.modalActive = true;
    const maxHeight = maxModalHeight(renderer);
    const textHeight = clamp(estimateWrappedRows(content, modalInnerWidth(renderer)), 3, Math.max(3, maxHeight - 5));
    const modal = modalBox(renderer, title, textHeight + 5);
    modal.add(new TextRenderable(renderer, { content, width: "100%", height: textHeight, fg: TEXT, bg: PANEL, wrapMode: "word", marginBottom: 1 }));
    modal.add(new TextRenderable(renderer, { content: "Enter/Esc/q = Close", width: "100%", height: 1, fg: MUTED, bg: PANEL, marginTop: 1 }));
    renderer.root.add(modal);
    renderer.root.requestRender();

    return new Promise((resolve) => {
      const done = () => {
        modal.onKeyDown = undefined;
        renderer.root.remove(modal.id);
        this.modalActive = false;
        this.render();
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

  private focusNext(): void {
    const components = this.requireComponents();
    const focusables = [components.files, components.chipQuery, components.chips];
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
    const fileOptions = this.files.length > 0 ? this.files.map(formatFileOption) : [{ name: "No files", description: "Press a to show all files, or add .bin/.rom/.hex/.srec/.eep files.", value: "" }];
    this.updateSelectOptions(this.components.files, fileOptions, this.files.length > 0 ? this.files.map((file) => `${file.path}:${file.size}:${file.modifiedAt.getTime()}:${file.sha256Short}`).join("\n") : "<no-files>");
    this.setSelectedIndex(this.components.files, fileOptions.findIndex((option) => option.value === this.selectedFile?.path));
    const chipOptions = formatChipOptions(this.chipResults, this.chipInfoCache);
    this.updateSelectOptions(this.components.chips, chipOptions, this.chipResults.map((chip) => `${chip}:${this.chipInfoCache.get(chip)?.raw ?? ""}`).join("\n"));
    this.setSelectedIndex(this.components.chips, chipOptions.findIndex((option) => option.value === this.selectedChip));
    this.renderFocusState(focus);
    const statusSummaryWidth = this.components.statusSummary.width > 0 ? this.components.statusSummary.width : undefined;
    this.components.statusSummary.content = formatStatusSummary({
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
    if (components.files.focused) return "Files";
    if (components.chipQuery.focused) return "Chip Search";
    if (components.chips.focused) return "Chip Results";
    return "Dialog";
  }

  private renderFocusState(focus: string): void {
    const components = this.requireComponents();
    setPanelFocus(components.filesPanel, "Files", focus === "Files");
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

function lineBox(renderer: CliRenderer, id: string, backgroundColor: string, getText: () => string): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    height: 1,
    width: "100%",
    backgroundColor,
    padding: 0,
    renderAfter: function (buffer) {
      buffer.drawText(truncateEnd(getText(), Math.max(0, this.width)), this.screenX, this.screenY, CHROME_FG);
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

function modalBox(renderer: CliRenderer, title: string, height: number): BoxRenderable {
  const modalHeight = clamp(height, 6, maxModalHeight(renderer));
  return new BoxRenderable(renderer, {
    id: `modal-${Date.now()}`,
    title: ` ${title} `,
    titleColor: PRIMARY,
    position: "absolute",
    zIndex: 100,
    top: Math.max(1, Math.floor((renderer.height - modalHeight) / 2)),
    left: "5%",
    width: "90%",
    height: modalHeight,
    border: true,
    borderStyle: "single",
    borderColor: BORDER_ACTIVE,
    focusedBorderColor: PRIMARY,
    backgroundColor: PANEL,
    padding: 1,
    flexDirection: "column",
  });
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

function footerText(): string {
  return "q quit | f files | / chips | r refresh | R read | m compare | p programmer | tab focus | enter select | c check | b blank | w write | v verify | a advanced | l log | ? help";
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

function formatChipOptions(chips: string[], infoByChip: Map<string, ChipInfo>): SelectOption[] {
  return chips.map((chip) => formatChipLabel(chip, infoByChip.get(chip)));
}

function setPanelFocus(panel: BoxRenderable, title: string, focused: boolean): void {
  panel.title = focused ? ` > ${title} ` : ` ${title} `;
  panel.titleColor = focused ? TEXT : PRIMARY;
  panel.borderColor = focused ? PRIMARY : BORDER;
}

function isProgrammerKind(value: string): value is ProgrammerKind {
  return value === "tl866a" || value === "tl866ii" || value === "t48" || value === "t56";
}

function isCancelKey(key: KeyEvent): boolean {
  return key.name === "escape" || key.name === "esc" || key.raw === "\x1b" || key.sequence === "\x1b" || (key.ctrl && key.name === "c");
}

function isKey(key: KeyEvent, value: string): boolean {
  return key.name === value || key.sequence === value || key.raw === value;
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
