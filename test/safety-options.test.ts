import { expect, test } from "bun:test";

import { programmerWriteWarnings } from "../src/safety/options";
import { TEST_CHIP } from "./support/fake-backend";

test("discloses catalog-mandated T76 unprotection", () => {
  const protectedChip = { ...TEST_CHIP, supportsUnprotect: true };
  expect(programmerWriteWarnings("t48", protectedChip)).toEqual([]);
  expect(programmerWriteWarnings("t56", protectedChip)).toEqual([]);
  expect(programmerWriteWarnings("t76", protectedChip)).toEqual([
    "T76 will automatically disable this target's software write protection before erase and will leave it disabled after writing.",
  ]);
  expect(programmerWriteWarnings("t76", { ...TEST_CHIP, supportsUnprotect: false })).toEqual([]);
});
