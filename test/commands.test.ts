import { expect, test } from "bun:test";

import {
  buildBlankCheckArgs,
  buildChipInfoArgs,
  buildDefaultWritePreview,
  buildPinCheckArgs,
  buildReadArgs,
  buildSearchChipsArgs,
  buildVerifyArgs,
  buildWriteArgs,
} from "../src/minipro/commands";

test("builds argv arrays for minipro commands", () => {
  expect(buildSearchChipsArgs("t48", "AT28C64B")).toEqual(["-q", "T48", "-L", "AT28C64B"]);
  expect(buildChipInfoArgs("t48", "AT28C64B")).toEqual(["-q", "T48", "-d", "AT28C64B"]);
  expect(buildPinCheckArgs("AT28C64B")).toEqual(["-p", "AT28C64B", "-z"]);
  expect(buildBlankCheckArgs("AT28C64B")).toEqual(["-p", "AT28C64B", "-b"]);
  expect(buildWriteArgs("AT28C64B", "image.bin")).toEqual(["-p", "AT28C64B", "-w", "image.bin"]);
  expect(buildVerifyArgs("AT28C64B", "image.bin")).toEqual(["-p", "AT28C64B", "-m", "image.bin"]);
  expect(buildReadArgs("AT28C64B", "readback.bin")).toEqual(["-p", "AT28C64B", "-r", "readback.bin"]);
});

test("passes chip names with package characters as one argv entry", () => {
  expect(buildChipInfoArgs("t48", "AT28C64B(Non-Standard)@SOIC28")).toEqual(["-q", "T48", "-d", "AT28C64B(Non-Standard)@SOIC28"]);
});

test("keeps dangerous flags absent from default flow", () => {
  const args = buildDefaultWritePreview("AT28C64B", "image.bin", "t48").flat();
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
  expect(flat).toContain("--no_size_error");
});
