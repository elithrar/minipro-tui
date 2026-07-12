import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  buildBlankCheckArgs,
  buildChipInfoArgs,
  buildDefaultWritePreview,
  buildPinCheckArgs,
  buildReadArgs,
  buildSearchChipsArgs,
  buildVerifyArgs,
  buildWriteArgs,
  runMinipro,
} from "../src/minipro/commands";

const fakeMinipro = join(import.meta.dir, "fixtures", "fake-minipro.ts");

test("builds argv arrays for minipro commands", () => {
  expect(buildSearchChipsArgs("t48", "AT28C64B")).toEqual(["-q", "T48", "-L", "AT28C64B"]);
  expect(buildChipInfoArgs("t48", "AT28C64B")).toEqual(["-q", "T48", "-d", "AT28C64B"]);
  expect(buildPinCheckArgs("AT28C64B")).toEqual(["-p", "AT28C64B", "-z"]);
  expect(buildBlankCheckArgs("AT28C64B")).toEqual(["-p", "AT28C64B", "-b"]);
  expect(buildWriteArgs("AT28C64B", "image.bin")).toEqual(["-p", "AT28C64B", "-w", "image.bin"]);
  expect(buildVerifyArgs("AT28C64B", "image.bin")).toEqual(["-p", "AT28C64B", "-m", "image.bin"]);
  expect(buildReadArgs("AT28C64B", "readback.bin")).toEqual(["-p", "AT28C64B", "-r", "readback.bin", "-c", "code"]);
});

test("passes chip names with package characters as one argv entry", () => {
  expect(buildChipInfoArgs("t48", "AT28C64B(Non-Standard)@SOIC28")).toEqual(["-q", "T48", "-d", "AT28C64B(Non-Standard)@SOIC28"]);
});

test("keeps user-requested dangerous overrides absent from default flow", () => {
  const args = buildDefaultWritePreview("AT28C64B", "image.bin", "t48").flat();
  expect(args.filter((arg) => arg === "--unprotect")).toHaveLength(1);
  expect(args).not.toContain("--skip_erase");
  expect(args).not.toContain("--skip_verify");
  expect(args).not.toContain("--no_size_error");
  expect(args).not.toContain("--no_id_error");
});

test("write preview reflects advanced options", () => {
  const commands = buildDefaultWritePreview("AT28C64B", "image.bin", "t48", {
    skipErase: true,
    skipVerify: true,
    allowSizeMismatch: true,
    disableReadbackCompare: true,
  });
  const flat = commands.flat();
  expect(commands.some((args) => args.includes("-E"))).toBe(false);
  expect(commands.some((args) => args.includes("-m"))).toBe(false);
  expect(commands.some((args) => args.includes("-r"))).toBe(false);
  expect(flat).toContain("--skip_erase");
  expect(flat).toContain("--skip_verify");
  expect(flat).toContain("--unprotect");
  expect(flat).toContain("--no_size_error");
});

test("write preview places an optional backup before erase", () => {
  const commands = buildDefaultWritePreview("AT28C64B", "image.bin", "t48", {}, "original.bin");
  expect(commands[3]).toEqual(["-p", "AT28C64B", "-r", "original.bin", "-c", "code"]);
  expect(commands[4]).toEqual(["-p", "AT28C64B", "-E"]);
});

test("scopes advanced options to minipro modes that support them", () => {
  const options = {
    vpp: "12V",
    skipErase: true,
    skipVerify: true,
    allowSizeMismatch: true,
    skipIdRead: true,
  } as const;

  expect(buildPinCheckArgs("AT28C64B", options)).toEqual(["-p", "AT28C64B", "-z"]);
  expect(buildBlankCheckArgs("AT28C64B", options)).toEqual(["-p", "AT28C64B", "-b"]);
  expect(buildReadArgs("AT28C64B", "read.bin", options)).toEqual(["-p", "AT28C64B", "-r", "read.bin", "-c", "code", "--skip_id"]);
  expect(buildWriteArgs("AT28C64B", "image.bin", options)).toEqual([
    "-p", "AT28C64B", "-w", "image.bin", "--vpp", "12", "--skip_erase", "--skip_verify", "--no_size_error",
  ]);
  expect(buildVerifyArgs("AT28C64B", "image.bin", options)).toContain("--no_size_error");
  expect(buildWriteArgs("SPI", "image.bin", { spiSpeed: "2" })).toContain("--speed");
  expect(buildWriteArgs("EPROM", "image.bin", { vpp: "12V", pulseDelay: "1000us" })).toEqual([
    "-p", "EPROM", "-w", "image.bin", "--vpp", "12", "--pulse", "1000",
  ]);
});

test("streams minipro output as complete log lines", async () => {
  const lines: string[] = [];
  const result = await runMinipro([fakeMinipro, "emit", "first\nsecond\n"], { binary: process.execPath, onLog: (line) => lines.push(line) });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("first\nsecond\n");
  expect(lines).toContain("first");
  expect(lines).toContain("second");
});

test("cancels a running minipro process and reports the abort", async () => {
  const controller = new AbortController();
  const resultPromise = runMinipro([fakeMinipro, "sleep", "5000"], {
    binary: process.execPath,
    signal: controller.signal,
    terminateGraceMs: 20,
  });
  controller.abort();

  const result = await resultPromise;
  expect(result.aborted).toBe(true);
  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain("cancelled by operator");
  expect(result.durationMs).toBeLessThan(1000);
});

test("force-kills a process tree that exceeds the output limit", async () => {
  const result = await runMinipro([fakeMinipro, "ignore-term-and-output", "0123456789abcdef"], {
    binary: process.execPath,
    maxOutputBytes: 8,
    terminateGraceMs: 20,
  });

  expect(result.exitCode).toBeNull();
  expect(result.stderr).toContain("output exceeded 8 bytes");
  expect(result.durationMs).toBeLessThan(1000);
});
