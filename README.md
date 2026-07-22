# minipro-tui

`minipro-tui` is an OpenTUI workbench for programming ROMs directly with XGecu USB programmers.

It scans the current directory for image files and uses [xgecu-web](https://github.com/elithrar/xgecu-web) for its device catalog, Zig/WebAssembly programming logic, reads, writes, pin checks, and verification. The Bun process talks to the programmer over USB without shelling out to the `minipro` command-line program.

<img width="1000" alt="minipro TUI screenshot of the workbench" src="https://github.com/user-attachments/assets/73f3df7b-0673-413b-acb4-8b2c70c00704" />

## Requirements

- Bun 1.3 or newer.
- An XGecu T48 for current catalog-backed hardware operations.
- OS permission to access the programmer over USB.

The app starts without connected hardware so you can inspect files and search the bundled xgecu device catalog. The defaults are the T48 catalog and `AT28C64B` chip query.

xgecu-web implements the T56 transport, but its bundled catalog does not yet contain validated T56 device records or algorithm payloads. T56 ROM operations remain unavailable until those records are added.

## Usage

```bash
bun install
bun run dev
```

Build a standalone executable:

```bash
bun run build
./minipro-tui
```

The executable keeps xgecu-web, node-usb, and the platform-specific OpenTUI packages external. Run it from the installed project directory so those dependencies remain available in `node_modules`.

Test and type-check:

```bash
bun test
bunx tsc --noEmit
```

## Architecture

The UI, safety workflow, and hardware transport are separate so the behavior can be tested without a connected programmer:

- `src/app.ts` owns the OpenTUI interface, persisted preferences, confirmation dialogs, and workflow orchestration.
- `src/files` scans the working directory, freezes selected file bytes, validates Intel HEX and S-record checksums, normalizes images, and computes SHA-256 hashes.
- `src/xgecu/workflow.ts` owns the read, compare, backup, and default write sequences. It depends on the `ProgrammerBackend` interface rather than USB hardware, so tests use an injected fake backend.
- `src/xgecu/direct.ts` is the production backend. It adapts [node-usb](https://github.com/node-usb/node-usb-rs) to xgecu-web's WebUSB-compatible transport and reuses the programmer connection until the app closes.
- xgecu-web resolves device metadata and runs the Zig/WebAssembly protocol state machine. node-usb performs the USB transfers from Bun to the T48.

`src/main.ts` only starts the app. No application code spawns `minipro`, parses its output, or reads its XML device database.

## Safe write flow

Press `w` to review and confirm the write. The default workflow:

- Freezes and hashes the selected image bytes before confirmation.
- Connects to the programmer directly over USB.
- Checks T48 pin contacts when the selected device supports it.
- Optionally reads, syncs, and commits a pre-write backup.
- Runs erase, a full blank readback, write, and backend verification through xgecu-web.
- Reads the chip again and compares every byte independently.

The mutation phase cannot be cancelled after it begins. xgecu-web always resets the programmer on operation completion or failure. Intel HEX and S-record images are checksum-validated and normalized before size checks and hardware access.

Electrical erase is only requested for devices that support it. Nonerasable devices must already be externally erased; xgecu-web blank-checks them before programming. Size mismatches remain blocked unless the explicit override is enabled, and erase writes always require a full code-memory image.

Disabling write protection is an explicit advanced option. When enabled, the confirmation warns that protection is not restored automatically.

Enable `Pre-write backup` under Advanced Controls to save the current contents before mutation. Hardware reads only create new files; existing and raced destinations are never replaced.

## Read and compare

Press `R` to read the selected chip to a new file. The app hashes and syncs the bytes before completing the operation.

Press `m` to freeze the selected local image, read the chip directly over USB, and compare every byte. Both hashes are reported on a mismatch.

## Keys

```text
q quit | r refresh | R read | m compare | p programmer | f file search | / chip search | tab/shift+tab focus | enter select | c check | b blank | w write | v verify | a advanced | i chip info | l log | ? help
```

The selected programmer, pre-write backup preference, file visibility, and recent selections persist under `${XDG_CONFIG_HOME:-~/.config}/minipro-tui/state.json`. Overrides that weaken hardware checks reset on launch.
