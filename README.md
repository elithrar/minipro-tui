# minipro-tui

`minipro-tui` is a terminal UI for safer chip programming with the `minipro` CLI and OpenTUI.

It scans the current directory for candidate image files, queries the live `minipro` chip database, and runs read, compare, pin check, blank check, verify, and safe write workflows without shell interpolation.

<img width="1000" alt="image" src="https://github.com/user-attachments/assets/43aaa758-18d6-4d4e-9167-3ef9cde780bd" />

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

Build a standalone binary:

```bash
bun run build
./minipro-tui
```

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
minipro -p <chip> -w <file>
minipro -p <chip> -m <file>
minipro -p <chip> -r <temp-readback-file>
```

The app then compares the selected file and readback byte-for-byte and shows SHA-256 summaries in the log.

## Read Flow

Press `R` to read the selected chip. The app opens a confirmation dialog with an editable filename, then runs:

```text
minipro -k
minipro -p <chip> -r <output-file>
```

After a successful read, the app hashes the output file and shows the SHA-256 checksum in the log.

## Compare Flow

Press `m` to compare the selected local file against the current contents of the selected chip. The app freezes and hashes the local file before confirmation, reads the chip to a temporary file, hashes the readback, then shows both SHA-256 hashes in a dialog:

```text
minipro -k
minipro -p <chip> -r <temp-compare-readback-file>
```

The dialog reports `matched` when the hashes are identical and `files do not match` when they differ.

## Keys

```text
q quit | r refresh | R read | m compare | p programmer | / chip search | tab focus | enter select | c check | b blank | w write | v verify | a advanced | l log | ? help
```

## Credit

This TUI wraps the `minipro` command-line programmer maintained by David Griffith and contributors: https://gitlab.com/DavidGriffith/minipro
