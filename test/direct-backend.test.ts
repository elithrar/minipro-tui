import { expect, test } from "bun:test";

import { createXgecuBackend, inferProgrammerKind } from "../src/xgecu/direct";

test("detects T76 from its distinct USB product ID", () => {
  expect(inferProgrammerKind("XGecu programmer", 0x1a86)).toBe("t76");
  expect(inferProgrammerKind("T48", 0x0a53)).toBe("t48");
  expect(inferProgrammerKind("T56", 0x0a53)).toBe("t56");
});

test("blocks T56 and T76 before USB access when no local algorithm is configured", async () => {
  const backend = await createXgecuBackend({ algorithmXmlPath: null });
  try {
    for (const programmerKind of ["t56", "t76"] as const) {
      await expect(backend.readROM({
        chip: "AT28C64B@DIP28",
        programmerKind,
      })).rejects.toThrow(`Set CHIPDESK_ALGORITHM_XML`);
    }
  } finally {
    await backend.close();
  }
});
