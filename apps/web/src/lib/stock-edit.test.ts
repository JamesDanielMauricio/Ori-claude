import { describe, expect, it } from "vitest";

import { stockEditCheck } from "./stock-edit";

describe("stockEditCheck", () => {
  it("accepts a total at the arranged floor", () => {
    expect(stockEditCheck({ picked: "8", leftover: "1", arranged: 9 })).toEqual({
      ok: true,
      picked: 8,
      leftover: 1,
    });
  });

  it("refuses below it", () => {
    expect(stockEditCheck({ picked: "8", leftover: "0", arranged: 9 })).toEqual({
      ok: false,
      reason: "below_arranged",
    });
  });

  it("an empty box is missing", () => {
    expect(stockEditCheck({ picked: "", leftover: "0", arranged: 0 })).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(stockEditCheck({ picked: "5", leftover: "", arranged: 0 })).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("0 and 0 are allowed when nothing is arranged", () => {
    expect(stockEditCheck({ picked: "0", leftover: "0", arranged: 0 })).toEqual({
      ok: true,
      picked: 0,
      leftover: 0,
    });
  });
});
