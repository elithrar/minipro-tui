import { expect, test } from "bun:test";

import { parseChipInfo, parseChipSearch, parseProgrammerDatabases, parseProgrammerStatus } from "../src/minipro/parse";

test("parses supported programmer list", async () => {
  const raw = await Bun.file("fixtures/minipro-q.txt").text();
  expect(parseProgrammerDatabases(raw)).toEqual([
    { kind: "tl866a", label: "TL866CS/A", raw: "tl866a:  TL866CS/A" },
    { kind: "tl866ii", label: "TL866II+", raw: "tl866ii: TL866II+" },
    { kind: "t48", label: "T48  (mostly complete)", raw: "t48:     T48  (mostly complete)" },
    { kind: "t56", label: "T56  (experimental)", raw: "t56:     T56  (experimental)" },
  ]);
});

test("parses no-programmer state", async () => {
  const raw = await Bun.file("fixtures/minipro-k-none.txt").text();
  expect(parseProgrammerStatus(raw)).toEqual({ connected: false, raw });
});

test("treats missing minipro binary as disconnected", () => {
  const raw = "spawn minipro ENOENT";
  expect(parseProgrammerStatus(raw)).toEqual({ connected: false, raw });
});

test("parses chip search results exactly", async () => {
  const raw = await Bun.file("fixtures/minipro-l-at28c64b.txt").text();
  expect(parseChipSearch(raw)).toContain("AT28C64B(Non-Standard)@SOIC28");
  expect(parseChipSearch(raw)).toContain("AT28C64B");
});

test("parses chip info fields and preserves raw output", async () => {
  const raw = await Bun.file("fixtures/minipro-d-at28c64b.txt").text();
  expect(parseChipInfo(raw)).toEqual({
    name: "AT28C64B",
    availableOn: "TL866A/CS",
    memoryBytes: 8192,
    packageName: "DIP28",
    icsp: "-",
    protocol: "0x07",
    readBufferSize: 512,
    writeBufferSize: 128,
    raw,
  });
});

test("keeps unknown chip info lines nonfatal", () => {
  const raw = "Name: FOO\nUnexpected: value\nMemory: 1,024 Bytes";
  expect(parseChipInfo(raw)).toEqual({ name: "FOO", memoryBytes: 1024, raw });
});
