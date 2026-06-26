# AGENTS.md

## Commands

- Install with `bun install`; this repo uses `bun.lock` and Bun 1.3+.
- Run the app with `bun run dev` or `bun run src/main.ts`.
- Build the standalone binary with `bun run build`; it writes `./minipro-tui` and keeps `@opentui/core-*` external for native OpenTUI packages.
- Run all tests with `bun test`.
- Run a focused test file with `bun test test/workflow.test.ts`.
- Type-check with `bunx tsc --noEmit`; there is no package script for it.
- There are no lint or formatter scripts/configs in this repo.

## Runtime Requirements

- Hardware workflows require `minipro` on `PATH`; tests do not.
- Override the minipro binary with `MINIPRO_BIN=/path/to/minipro` when running the app.
- The app can start without a connected programmer; default database is `T48`, default chip query is `AT28C64B`.

## Code Map

- `src/main.ts` is only the process entrypoint; `src/app.ts` owns the OpenTUI UI, key bindings, state, dialogs, and workflow orchestration.
- `src/minipro/commands.ts` is the only place that should spawn `minipro`; keep commands as argv arrays, not shell strings.
- `src/minipro/workflow.ts` contains read, compare, and default write flows; it accepts an injected `runCommand` so tests can run without hardware.
- `src/files/scan.ts` scans `process.cwd()` and only shows `.bin`, `.rom`, `.hex`, `.srec`, and `.eep` by default.
- `src/safety/options.ts` centralizes dangerous option warnings; update it when adding advanced flags that weaken checks.

## Safety Invariants

- Preserve the default write sequence: detect programmer, load chip info, pin/contact check, erase, blank check, write, verify, readback, byte compare.
- Write and compare flows freeze confirmed file bytes before hardware actions; do not reread the mutable source path for the write payload.
- Size mismatches are blocked unless `allowSizeMismatch` is explicitly enabled.
- Keep hardware-affecting overrides visible in the UI and confirmation flow.

## Testing Notes

- Prefer unit tests with injected `WorkflowCommandRunner` instead of invoking real `minipro`.
- Existing tests create temporary fixtures under `test/.tmp-*`; they are disposable.
