# minipro-tui Plan

Build a TypeScript terminal UI for safely programming chips with the `minipro` CLI. The app should run with Bun during development and compile to a standalone binary with `bun build --compile`.

Assumptions:

- `minipro` is available on `PATH`.
- The app controls XGecu-compatible programmers supported by `minipro`, including T48, T56, TL866II+, and TL866A/CS.
- The app programs chips selected from the actual `minipro` device database, not hardcoded or synthesized names.
- The default workflow should favor safety over speed.
- The current repo is greenfield except for the license.

## Goals

- Show connected programmer status in a toolbar or status bar.
- Show files in the current folder with name, size, modified date, and short SHA-256 hash.
- Let the user search, select, and inspect chips before programming.
- Support pin/contact check, blank check, write, verify, and readback compare.
- Provide a default safe flow for writing any selected binary.
- Expose advanced current, voltage, memory, and safety controls without making dangerous options easy to use accidentally.
- Compile to a local binary that can be run without invoking `bun` directly.

## Non-Goals For The MVP

- No firmware update support.
- No custom `infoic.xml`, `logicic.xml`, or `algorithm.xml` editing.
- No automatic recursive file browser.
- No chip database cache beyond the current process.
- No tuning, checksum correction, or semantic validation of binary contents.
- No guarantee that a programmed binary is safe for an engine or target system. The TUI only verifies byte-level programming success.

## Stack

Use TypeScript and Bun.

Recommended dependencies:

- `blessed` for the TUI.
- `@types/blessed` for TypeScript support.
- Bun test runner via `bun test`.
- Built-in Node-compatible modules through Bun:
  - `child_process` for invoking `minipro`.
  - `fs` and `path` for file scanning.
  - `crypto` for SHA-256 hashing.
  - `os` for temp paths and platform details.

Prefer `blessed` over React-style terminal libraries because this app is pane-oriented: status bars, file lists, chip lists, logs, and confirmation dialogs.

## Build Commands

Initial setup:

```bash
bun init
bun add blessed
bun add -d @types/blessed
```

Development:

```bash
bun run src/main.ts
```

Tests:

```bash
bun test
```

Binary build:

```bash
bun build src/main.ts --compile --outfile minipro-tui
```

Run compiled binary:

```bash
./minipro-tui
```

## Project Layout

```text
src/
  main.ts
  app.ts
  types.ts
  tui/
    layout.ts
    keybindings.ts
    modals.ts
    render.ts
  minipro/
    commands.ts
    parse.ts
    workflow.ts
  files/
    scan.ts
    hash.ts
  safety/
    options.ts
    validation.ts
test/
  minipro-parse.test.ts
  workflow.test.ts
fixtures/
  minipro-k-none.txt
  minipro-q.txt
  minipro-l-at28c64b.txt
  minipro-d-at28c64b.txt
```

Keep modules small, but avoid premature abstraction. The important boundary is between the UI, the `minipro` command adapter, file scanning, and workflow execution.

## Core Data Types

Start with simple types in `src/types.ts`.

```ts
export type ProgrammerKind = "tl866a" | "tl866ii" | "t48" | "t56";

export type ProgrammerStatus = {
  connected: boolean;
  model?: string;
  raw: string;
};

export type FileEntry = {
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
  sha256Short: string;
};

export type ChipInfo = {
  name: string;
  availableOn?: string;
  memoryBytes?: number;
  packageName?: string;
  icsp?: string;
  protocol?: string;
  readBufferSize?: number;
  writeBufferSize?: number;
  raw: string;
};

export type MiniproResult = {
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type JobState =
  | { kind: "idle" }
  | { kind: "running"; step: string }
  | { kind: "failed"; step: string; message: string }
  | { kind: "done"; message: string };
```

Use exact chip names returned by `minipro -L`. Do not append package suffixes in code. For example, on one observed install `AT28C64B` is valid and `AT28C64B@DIP28` is not.

## minipro Commands

All `minipro` calls should go through `src/minipro/commands.ts`.

Rules:

- Use `spawn` with argv arrays, never shell strings.
- Capture stdout, stderr, exit code, and duration.
- Append every command and output to the UI log.
- Do not run destructive commands unless the user confirmed the workflow.
- Prefer documented short flags where behavior is known.

Read-only commands:

```text
minipro -Q
minipro -k
minipro -q <programmer> -L <query>
minipro -q <programmer> -d <chip>
```

Programming and validation commands:

```text
minipro -p <chip> -z
minipro -p <chip> -E
minipro -p <chip> -b
minipro -p <chip> -w <file>
minipro -p <chip> -m <file>
minipro -p <chip> -r <readback-file>
```

Important command details:

- `-p` is the chip/device name, not the programmer model.
- `-q` selects the programmer database for listing and info commands.
- `-E` means erase-only.
- `-e` means skip erase. Treat it as dangerous.
- `-v` means skip verify. Treat it as dangerous.
- `-b` means blank check. Do not label it as a literal zero check unless separately checking file contents for `0x00`.
- `-s` allows size mismatch as warning. Treat it as dangerous.
- `-y` ignores ID mismatch. Treat it as dangerous.

## Parsing Plan

Add parser tests before wiring parser results into the UI.

Supported programmer output from `minipro -Q` looks like:

```text
tl866a:  TL866CS/A
tl866ii: TL866II+
t48:     T48  (mostly complete)
t56:     T56  (experimental)
```

No-programmer output from `minipro -k` may look like:

```text
[No programmer found]
```

Chip search output from `minipro -q T48 -L AT28C64B` may look like:

```text
AT28C64B(Non-Standard)
AT28C64B(Non-Standard)@SOIC28
AT28C64B(Non-Standard)@PLCC32
AT28C64B
AT28C64B@SOIC28
AT28C64B@PLCC32
CAT28C64B
CAT28C64B@SOIC28
CAT28C64B@PLCC32
```

Chip info output from `minipro -q T48 -d AT28C64B` may look like:

```text
Name: AT28C64B
Available on: TL866A/CS
Memory: 8192 Bytes
Package: DIP28
ICSP: -
Protocol: 0x07
Read buffer size: 512 Bytes
Write buffer size: 128 Bytes
```

Parsing should be tolerant:

- Preserve raw output even when typed parsing fails.
- Do not fail the UI because an optional field is missing.
- Treat nonzero exits as command errors, but still show stdout and stderr.

## UI Layout

Use a single-screen dashboard.

Top status bar:

```text
minipro-tui | Programmer: T48 connected | DB: t48 | Chip: AT28C64B | File: image.bin 8192 B a1b2c3d4 | idle
```

Main panes:

```text
+-------------------------------+--------------------------------+
| Files                         | Chip Search                    |
| name size modified sha        | query/results                  |
|                               |                                |
+-------------------------------+--------------------------------+
| Chip Info                     | Actions / Log                  |
| memory/package/pin info       | workflow progress + output     |
+-------------------------------+--------------------------------+
```

Footer help bar:

```text
q quit | r refresh | / chip search | tab focus | enter select | c check | b blank | w write flow | v verify | a advanced
```

## Keybindings

- `q`: quit after confirming if a job is running.
- `r`: refresh programmer status and file list.
- `tab`: cycle focus between panes.
- `up/down`: move within focused list.
- `enter`: select focused file or chip.
- `/`: focus chip search input.
- `c`: run pin/contact check for selected chip.
- `b`: run blank check for selected chip.
- `w`: run default write flow for selected chip and file.
- `v`: verify selected file against selected chip.
- `a`: open advanced controls.
- `l`: toggle expanded log view.
- `?`: show help.

## File Browser

The MVP should scan only the current working directory.

For each regular file, show:

- Name.
- Size in bytes and human-readable form.
- Modified date.
- Short SHA-256, for example first 8 or 12 hex characters.

Recommended behavior:

- Show likely binary/programming files first: `.bin`, `.rom`, `.hex`, `.srec`, `.eep`.
- Provide a toggle to show all files.
- Cache hashes by path, size, and mtime to avoid rehashing unchanged large files.
- Recompute hash when size or mtime changes.
- Do not hash directories.

## Chip Selection

Chip search should be explicit and database-backed.

Flow:

1. User selects programmer database, defaulting to `t48` if no programmer is connected.
2. User types a chip query, for example `AT28C64B`.
3. App runs `minipro -q <programmer> -L <query>`.
4. App displays exact returned names.
5. User selects one exact name.
6. App runs `minipro -q <programmer> -d <chip>`.
7. App displays parsed and raw chip info.

When a programmer is connected, prefer its detected model for the database. When no programmer is connected, keep the selected database visible so offline chip selection still works.

## Default Write Flow

The default write flow should be the safest common EEPROM/EPROM flow.

Preconditions:

- A file is selected.
- A chip is selected.
- Chip info has been loaded.
- The user confirms that the operation may erase and write the chip.
- File size matches chip memory size when chip memory size is known, unless the user explicitly enabled the size-mismatch override.

Steps:

1. Run `minipro -k` and require a connected programmer.
2. Record selected file size and SHA-256.
3. Run `minipro -q <programmer> -d <chip>` and show chip info.
4. Run pin/contact check: `minipro -p <chip> -z`.
5. Run erase: `minipro -p <chip> -E`.
6. Run blank check: `minipro -p <chip> -b`.
7. Run write: `minipro -p <chip> -w <file>`.
8. Run explicit verify: `minipro -p <chip> -m <file>`.
9. Read back to a temp file: `minipro -p <chip> -r <readback-file>`.
10. Compare original file and readback byte-for-byte.
11. Show final checksum summary.

If any step fails:

- Stop the workflow.
- Show the failed command, exit code, stdout, and stderr.
- Do not continue to the next destructive or dependent step.
- Suggest reseating the chip, cleaning pins, confirming chip selection, and rerunning pin check where appropriate.

## Separate Actions

Pin/contact check:

```text
minipro -p <chip> -z
```

Blank check:

```text
minipro -p <chip> -b
```

Verify selected file:

```text
minipro -p <chip> -m <file>
```

Read chip to file:

```text
minipro -p <chip> -r <output-file>
```

Readback compare:

```text
minipro -p <chip> -r <temp-readback-file>
```

Then compare the selected file and readback in TypeScript.

## Advanced Controls

Advanced controls should be grouped by risk.

Normal advanced options:

- Memory type: `-c code|data|config|user|calibration`.
- File format override: `-f ihex|srec`.
- VPP: `--vpp <value>`.
- VDD: `--vdd <value>`.
- VCC: `--vcc <value>`.
- Pulse delay: `--pulse <value>`.
- SPI speed for supported devices: `--speed <value>`.
- Disable protection before programming: `--unprotect`.
- Enable protection after programming: `--protect`.
- ICSP with VCC: `--icsp_vcc`.
- ICSP without VCC: `--icsp_no_vcc`.

Dangerous options requiring explicit confirmation:

- Skip erase: `--skip_erase` / `-e`.
- Skip verify: `--skip_verify` / `-v`.
- Ignore file size mismatch: `--no_size_error` / `-s`.
- Ignore ID mismatch: `--no_id_error` / `-y`.
- Skip ID read in read mode: `--skip_id` / `-x`.

Confirmation text for dangerous options should name the exact risk. For example:

```text
Skip verify is enabled. The app will not confirm that bytes on the chip match the selected file after writing.
```

## Safety Rules

- Never start erase or write without a confirmation dialog.
- Show the exact command sequence before a destructive workflow.
- Do not use shell interpolation for paths or chip names.
- Do not synthesize chip names. Use names returned by `minipro -L`.
- Block default write flow if file size differs from parsed chip memory size.
- Keep verification enabled by default.
- Do not expose firmware update in the MVP.
- Keep readback compare enabled in the default flow unless the user explicitly disables it in advanced settings.
- Treat no connected programmer as a normal disconnected state, not a crash.
- Preserve full command output in the log.

## Job Execution Model

Run `minipro` operations as background jobs so the UI remains responsive.

Recommended model:

- Only one hardware job may run at a time.
- UI state has a current `JobState`.
- Each workflow step emits log events.
- A running job can be cancelled only between commands in the MVP.
- If a command is running, show that cancellation waits for the current command to exit.

Do not run two `minipro` hardware commands concurrently. The programmer is a single hardware resource.

## Testing Plan

Prioritize parser and workflow safety tests.

Parser tests:

- Parse supported programmer list.
- Parse no-programmer state.
- Parse chip search results.
- Parse chip info fields.
- Preserve raw output for unknown chip info lines.

Command builder tests:

- Build argv arrays for each `minipro` command.
- Confirm chip names with spaces, parentheses, and `@` are passed as single argv entries.
- Confirm dangerous flags are absent from default flow.

Workflow tests:

- Default flow includes pin check, erase, blank check, write, verify, readback compare.
- Default flow blocks on missing file.
- Default flow blocks on missing chip.
- Default flow blocks on known size mismatch.
- Default flow allows size mismatch only when explicit override is enabled.
- Workflow stops after a failed step.

File tests:

- File scanner excludes directories.
- Hash cache invalidates when file size or mtime changes.
- Short SHA output is stable.

Manual hardware tests:

- Launch with no programmer connected.
- Launch with T48 connected.
- Search `AT28C64B` using T48 database.
- Load chip info for `AT28C64B`.
- Run pin/contact check with chip inserted.
- Run blank check on a known blank chip.
- Program a disposable chip with a known test binary.
- Verify and readback compare the programmed chip.

## Implementation Steps

### Step 1: Initialize The Bun Project

- Run `bun init`.
- Add `blessed` and `@types/blessed`.
- Add TypeScript config if Bun does not create one.
- Add scripts to `package.json`:
  - `dev`: `bun run src/main.ts`
  - `test`: `bun test`
  - `build`: `bun build src/main.ts --compile --outfile minipro-tui`

### Step 2: Add Types And Command Runner

- Create `src/types.ts`.
- Create `src/minipro/commands.ts`.
- Implement a generic `runMinipro(args: string[]): Promise<MiniproResult>`.
- Add typed wrappers for read-only commands first.
- Log command argv as an array, not a shell string.

### Step 3: Add Parsers And Fixtures

- Create parser fixtures from observed command outputs.
- Create `src/minipro/parse.ts`.
- Add parser tests with `bun test`.
- Keep parser failures nonfatal where possible.

### Step 4: Add File Scanning

- Create `src/files/scan.ts`.
- Create `src/files/hash.ts`.
- Scan current directory for regular files.
- Compute size, modified date, and short SHA-256.
- Add tests for scanner and hash behavior.

### Step 5: Build The Basic TUI Shell

- Create `src/main.ts`.
- Create `src/app.ts`.
- Create `src/tui/layout.ts`.
- Render status bar, file pane, chip pane, info pane, and log pane.
- Implement quit, refresh, focus movement, and list selection.

### Step 6: Wire Read-Only minipro Actions

- On startup, run `minipro -Q` and `minipro -k`.
- Show disconnected state when no programmer is found.
- Add chip search input.
- Run `minipro -q <programmer> -L <query>` from chip search.
- Load chip info with `minipro -q <programmer> -d <chip>` after chip selection.

### Step 7: Add Safe Single Actions

- Add pin/contact check action.
- Add blank check action.
- Add verify action.
- Show command progress and output in the log pane.
- Disable actions when required file or chip selection is missing.

### Step 8: Add Default Write Workflow

- Implement `src/minipro/workflow.ts`.
- Show command preview before destructive operations.
- Require explicit confirmation.
- Run the safe default sequence.
- Stop on first failure.
- Show final checksum and readback compare result.

### Step 9: Add Advanced Controls

- Create `src/safety/options.ts`.
- Create `src/safety/validation.ts`.
- Add advanced modal.
- Add safe advanced options first.
- Add dangerous options with explicit warnings and confirmation.
- Ensure dangerous flags are never included unless enabled intentionally.

### Step 10: Polish And Package

- Improve empty states and error messages.
- Add help modal.
- Add full-log view.
- Run `bun test`.
- Build with `bun build src/main.ts --compile --outfile minipro-tui`.
- Test the compiled binary.
- Document usage in `README.md`.

## MVP Acceptance Criteria

- `bun test` passes.
- `bun run src/main.ts` launches the TUI.
- `bun build src/main.ts --compile --outfile minipro-tui` creates a runnable binary.
- App starts cleanly with no programmer connected.
- Status bar shows disconnected programmer state.
- File list shows name, size, modified date, and short SHA-256.
- Chip search uses `minipro -q <programmer> -L <query>`.
- Chip info uses `minipro -q <programmer> -d <chip>`.
- Default write flow previews commands and requires confirmation.
- Default write flow includes pin check, erase, blank check, write, verify, and readback compare.
- Dangerous flags are not used unless explicitly enabled in advanced controls.
