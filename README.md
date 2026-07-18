# minipro-tui

`minipro-tui` is a terminal UI for safer chip programming with the `minipro` CLI and OpenTUI.

It scans the current directory for candidate image files, queries the live `minipro` chip database, and runs read, compare, pin check, blank check, verify, and safe write workflows without shell interpolation.

<img width="1000" alt="minipro TUI screenshot of the workbench" src="https://github.com/user-attachments/assets/73f3df7b-0673-413b-acb4-8b2c70c00704" />

## Requirements

- Bun 1.3 or newer.
- `minipro` on `PATH` for hardware operations.
- An XGecu-compatible programmer supported by `minipro` for programming workflows.

The app does not require a programmer connected so you can inspect files and search the chip database offline. The default programmer database is `T48`, and the default chip query is `AT28C64B`.

## Usage

Install:

```bash
bun install
```

Run during development:

```bash
bun run src/main.ts
```

or:

```bash
bun run dev
```

Build a compiled executable:

```bash
bun run build
./minipro-tui
```

Run the executable from an installed project directory so the platform-specific OpenTUI native package in `node_modules` remains available.

Test:

```bash
bun test
```

## Default Safe Write Flow

The `w` key previews the command sequence and requires confirmation before erase or write. The default flow checks contact, writes, verifies, and readback-compares:

```text
minipro -k
minipro -q <programmer> -d <chip>
minipro -p <chip> -z
minipro -p <chip> -E
minipro -p <chip> -b
minipro -p <chip> -w <confirmed-temp-file> --unprotect
minipro -p <chip> -m <file>
minipro -p <chip> -r <temp-readback-file> -c code
```

The write command disables supported software write protection and retains Minipro's normal erase and verify behavior in addition to the workflow's explicit checks. The app never enables chip protection. It freezes the confirmed bytes, then compares the selected image and readback byte-for-byte and shows SHA-256 summaries in the log. Intel HEX and S-record images are checksum-validated and normalized to raw bytes before size checks and hardware actions.

Pin/contact checks run when supported; an explicit unsupported response is logged and the workflow continues. Raw operation images are limited to 64 MiB and structured source images to 4 MiB to keep file freezing and normalization bounded.

Enable `Pre-write backup` under Advanced Controls to read the selected memory region to a new file before erase. The backup is hashed, synced, and committed before the workflow can continue. Existing files are never replaced by hardware reads.

## Read Flow

Press `R` to read the selected chip. The app opens a confirmation dialog with an editable filename, then runs:

```text
minipro -k
minipro -p <chip> -r <output-file> -c code
```

After a successful read, the app hashes and syncs a temporary output before atomically committing a new destination. Existing destinations are refused and failed reads preserve the filesystem. Reads default to the chip's `code` memory region so multi-region devices cannot create untracked sibling files.

## Compare Flow

Press `m` to compare the selected local file against the current contents of the selected chip. The app freezes and hashes the local file before confirmation, reads the chip to a temporary file, hashes the readback, then shows both SHA-256 hashes in a dialog:

```text
minipro -k
minipro -p <chip> -r <temp-compare-readback-file> -c code
```

The dialog reports `matched` when the hashes are identical and `files do not match` when they differ.

## Keys

```text
q quit | r refresh | R read | m compare | p programmer | f file search | / chip search | tab/shift+tab focus | enter select | c check | b blank | w write | v verify | a advanced | i chip info | l log | ? help
```

The second status line shows the next setup step, active work, and action errors. The footer changes with the focused pane so the relevant controls stay visible.

When the footer shows `esc cancel`, Escape safely cancels the active detection, read, check, verify, or readback command. Erase and write transfers are intentionally non-cancellable. Terminals narrower than 90 columns switch to Files, Chips, Status, and Log tabs.

The selected programmer database, pre-write backup preference, file visibility, and recent selections persist under `${XDG_CONFIG_HOME:-~/.config}/minipro-tui/state.json`. Overrides that weaken hardware checks always reset on launch.

## Credit

This TUI wraps the `minipro` command-line programmer maintained by David Griffith and contributors: https://gitlab.com/DavidGriffith/minipro
