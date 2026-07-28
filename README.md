# ChipDesk

ChipDesk is an OpenTUI workbench for programming ROMs directly with XGecu T48 and T56 USB programmers.

It scans the current directory for image files and uses the xgecu-web Zig/WebAssembly backend for its device catalog, USB transport, reads, writes, pin checks, and verification. The `minipro` command-line program is not required.

<img width="1000" alt="ChipDesk EEPROM workbench" src="https://github.com/user-attachments/assets/73f3df7b-0673-413b-acb4-8b2c70c00704" />

## Requirements

- Bun 1.3 or newer.
- An XGecu T48 or T56 for hardware operations.
- OS permission to access the programmer over USB.

The app starts without connected hardware so you can inspect files and search the bundled xgecu device catalog. The defaults are the T48 catalog and `AT28C64B` chip query.

## Usage

```bash
bun install
bun run dev
```

Build and test:

```bash
bun run build
bun test
bunx tsc --noEmit
```

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

The selected programmer, pre-write backup preference, file visibility, and recent selections persist under `${XDG_CONFIG_HOME:-~/.config}/chipdesk/state.json`. Set `CHIPDESK_STATE` to use a different state file. Overrides that weaken hardware checks reset on launch.

## Backend

[xgecu-web](https://github.com/elithrar/xgecu-web) provides the Zig device logic, WebAssembly API, and WebUSB-compatible transport. [node-usb](https://github.com/node-usb/node-usb-rs) supplies the unrestricted USB provider used by the Bun process.
