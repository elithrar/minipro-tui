# ChipDesk

**ChipDesk is a terminal workbench for XGecu T48, T56, and T76 USB programmers.** Read, compare, verify, and write ROM images directly over USB—no XGPro or `minipro` CLI required.

ChipDesk builds on [xgecu-web](https://github.com/elithrar/xgecu-web) for its Zig/WebAssembly device logic and direct USB transport. Its catalog-backed 28-pin ROM path covers T48, T56, and T76, with shared preflight, transfer, verification, and readback guardrails. T56 and T76 remain software-qualified pending physical hardware traces.

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

T56 and T76 operations also require an `algorithm.xml` obtained locally from the matching XGPro installation. ChipDesk never bundles, uploads, or persists that vendor file. Point to it when launching:

```bash
CHIPDESK_ALGORITHM_XML=/path/to/algorithm.xml /path/to/chipdesk/chipdesk
```

The XGECU core extracts only the requested algorithm and verifies its CRC, decoded size, and catalog-pinned SHA-256 before any algorithm upload or ROM operation begins.

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

## Credits

Protocol and catalog support is based on [minipro](https://gitlab.com/DavidGriffith/minipro), with a reimplementation in Zig as part of [xgecu-web](https://github.com/elithrar/xgecu-web) to support multiple transports (incl. WebUSB). 

See [workbench.questionable.services](https://workbench.questionable.services/) and launch the ChipProgrammer app with a T48 programmer attached for a browser-based, Motronic-ROM focused version of this.

## Contributing

Contributions and PRs are welcome. Keep them focused on XGecu programmers—especially T48, T56, and T76—and the workflows around them. Support for unrelated programmer families may not be accepted.
