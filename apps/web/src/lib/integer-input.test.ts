import { describe, expect, it } from "vitest";

import { stripDecimal, wholeNumberKey } from "./integer-input";

// Types `keys` into an empty whole-pallet box the way a browser would once
// wholeNumberKey has had its say: a key it lets through types its digit (or,
// for Backspace, deletes one); a key it stops types nothing. Returns what the
// box ends up holding.
function typeKeys(keys: string[], modified = false): string {
  let text = "";
  let cutting = false;
  for (const key of keys) {
    const result = wholeNumberKey(key, modified, cutting);
    cutting = result.cutting;
    if (result.action !== "allow") continue;
    if (/^\d$/.test(key)) text += key;
    if (key === "Backspace") text = text.slice(0, -1);
  }
  return text;
}

// Found in testing (2026-11-20): the point was swallowed but the digits after
// it were not, so a grower typing 2.5 saved 25 — ten times the stock.
describe("wholeNumberKey", () => {
  it("ends the number at a point or comma: the digits after it are not typed", () => {
    expect(typeKeys([..."2.5"])).toBe("2");
    expect(typeKeys([..."3,75"])).toBe("3");
    expect(typeKeys([..."12.0"])).toBe("12");
  });

  it("ends the number at an exponent too, so 1e3 is not 13", () => {
    expect(typeKeys([..."1e3"])).toBe("1");
    expect(typeKeys([..."1E3"])).toBe("1");
  });

  it("says when a key ended the number, so the box can tell the person why", () => {
    expect(wholeNumberKey(".", false, false)).toEqual({ action: "cut", cutting: true });
    expect(wholeNumberKey("5", false, true)).toEqual({ action: "block", cutting: true });
  });

  it("goes back to normal typing after any other key", () => {
    expect(typeKeys(["2", ".", "5", "Backspace", "4"])).toBe("4");
    expect(typeKeys(["2", ".", "ArrowLeft", "1"])).toBe("21");
  });

  it("never types a sign, and keeps the digits after it", () => {
    expect(typeKeys([..."-5"])).toBe("5");
    expect(typeKeys([..."+3"])).toBe("3");
  });

  it("types whole numbers as they are", () => {
    expect(typeKeys([..."120"])).toBe("120");
  });

  it("leaves the browser's Ctrl/Cmd shortcuts alone, zoom included", () => {
    for (const key of ["-", "+", "e", "."]) {
      expect(wholeNumberKey(key, true, false)).toEqual({ action: "allow", cutting: false });
    }
  });
});

// The grower's pick boxes take whole pallets only (decision D18). A number
// input also reports signs and exponents as valid values, so the filter has
// to keep digits alone, not merely cut at a decimal separator.
describe("stripDecimal", () => {
  it("keeps a whole number as it is", () => {
    expect(stripDecimal("12")).toBe("12");
    expect(stripDecimal("0")).toBe("0");
    expect(stripDecimal("")).toBe("");
  });

  it("cuts a pasted decimal at its separator", () => {
    expect(stripDecimal("8.5")).toBe("8");
    expect(stripDecimal("8,5")).toBe("8");
  });

  it("drops a minus sign rather than keeping a negative count", () => {
    expect(stripDecimal("-5")).toBe("");
  });

  it("cuts an exponent, so '1e3' is not 1,000 pallets and '2e-1' not a fraction", () => {
    expect(stripDecimal("1e3")).toBe("1");
    expect(stripDecimal("2e-1")).toBe("2");
    expect(stripDecimal("+3")).toBe("");
  });
});
