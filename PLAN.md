# Direct xgecu backend

The TUI uses xgecu-web instead of executing an external programmer command.

## Architecture

- `src/xgecu/backend.ts` adapts xgecu-web and the Node USB provider to the app-facing `ProgrammerBackend` interface.
- `src/xgecu/workflow.ts` owns read, compare, and safe write orchestration.
- `src/app.ts` owns UI state, confirmation, cancellation, and progress display.
- Tests inject `ProgrammerBackend`; they never require USB hardware.

## Safety contract

- Freeze source bytes before confirmation and hardware access.
- Check contacts when supported.
- Complete a requested backup before mutation.
- Blank-check after electrical erase or before writing an externally erased device.
- Verify in the backend, then perform an independent readback byte comparison.
- Create hardware-read destinations with exclusive file creation and sync them before reporting success.
- Keep erase/write non-cancellable while allowing reads and checks to abort through `AbortSignal`.
