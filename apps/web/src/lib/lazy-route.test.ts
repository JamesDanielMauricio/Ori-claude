import { describe, expect, it } from "vitest";

import { RELOAD_GUARD_MS, reloadedRecently } from "./lazy-route";

// The guard against reloading forever for a chunk that keeps failing. It used
// to be cleared by any chunk that loaded, and a screen's layout always loads
// first in the reloaded page — so a broken screen reloaded the tab endlessly.

const now = 1_800_000_000_000;

describe("reloadedRecently", () => {
  it("allows the first reload", () => {
    expect(reloadedRecently(null, now)).toBe(false);
  });

  it("refuses a second reload soon after the first, whatever loaded in between", () => {
    expect(reloadedRecently(String(now - 5_000), now)).toBe(true);
  });

  it("allows a reload again once the window has passed", () => {
    expect(reloadedRecently(String(now - RELOAD_GUARD_MS), now)).toBe(false);
  });

  it("treats the old flag value and anything unreadable as long ago", () => {
    expect(reloadedRecently("1", now)).toBe(false);
    expect(reloadedRecently("garbage", now)).toBe(false);
  });

  it("does not stay stuck when the clock moved backwards", () => {
    expect(reloadedRecently(String(now + 3_600_000), now)).toBe(false);
  });
});
