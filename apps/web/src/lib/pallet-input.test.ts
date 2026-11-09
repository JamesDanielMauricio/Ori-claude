import { describe, expect, it } from "vitest";

import { limitToOneDecimal } from "./pallet-input";

describe("limitToOneDecimal", () => {
  it.each([
    ["", ""],
    ["4", "4"],
    ["12", "12"],
    ["0.4", "0.4"],
    ["2.", "2."],
    [".5", ".5"],
  ])("keeps %j as %j", (typed, kept) => {
    expect(limitToOneDecimal(typed)).toBe(kept);
  });

  it.each([
    ["0.45", "0.4"],
    ["2.55", "2.5"],
    ["1,5", "1.5"],
    [" 3 ", "3"],
  ])("cuts %j back to %j", (typed, kept) => {
    expect(limitToOneDecimal(typed)).toBe(kept);
  });

  it.each([
    ["-1", ""],
    ["1e5", "1"],
    ["abc", ""],
    ["1.2.3", "1.2"],
  ])("ends the number at anything else: %j becomes %j", (typed, kept) => {
    expect(limitToOneDecimal(typed)).toBe(kept);
  });
});
