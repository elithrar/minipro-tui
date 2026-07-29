# ChipDesk

**ChipDesk is a terminal workbench for XGecu T48 and T56 USB programmers.** Read, compare, verify, and write ROM images directly over USB—no XGPro or `minipro` CLI required.

ChipDesk focuses on the XGecu programmer family. T48 is the current catalog-backed hardware path; T56 protocol support is present, with device operations expanding as validated T56 records and algorithms land.

<img width="1000" alt="ChipDesk EEPROM workbench" src="https://github.com/user-attachments/assets/ea4a8902-0253-4e04-9e88-f724f6830a0a" />

## Run

```bash
git clone https://github.com/elithrar/chipdesk.git
cd chipdesk
bun install
bun run build
```

Launch the app from the directory containing your ROM images:

```bash
cd /path/to/roms
/path/to/chipdesk/chipdesk
```

Requires Bun 1.3 or newer and OS permission to access the programmer over USB. ChipDesk scans the current directory for `.bin`, `.rom`, `.hex`, `.srec`, and `.eep` files. It starts without connected hardware, so you can inspect images and search the device catalog first.

## Keys

```text
Tab / Shift+Tab  move focus
F                 search files
/                 search devices
Enter             select
R                 refresh
Shift+R           read
W                 write
M                 compare
A                 advanced controls
?                 full keyboard reference
Q                 quit
```

Write confirmations default to cancel. Before mutation, ChipDesk freezes and hashes the image, checks contacts when supported, can save a pre-write backup, blank-checks, verifies, and compares an independent readback. Erase and write cannot be cancelled once they begin.

## Related projects

ChipDesk uses [xgecu-web](https://github.com/elithrar/xgecu-web) for its Zig/WebAssembly device logic and direct USB transport. Its protocol and catalog work builds on the upstream [minipro library](https://gitlab.com/DavidGriffith/minipro).

## Contributing

Contributions and PRs are welcome. Keep them focused on XGecu programmers—especially T48 and T56—and the workflows around them. Support for unrelated programmer families may not be accepted.
