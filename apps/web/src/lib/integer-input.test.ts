import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { blockDecimalKey, stripDecimal } from "./integer-input";

function keydown(key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const event = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  const preventDefault = vi.fn();
  blockDecimalKey({
    ...event,
    ...modifiers,
    preventDefault,
  } as unknown as KeyboardEvent<HTMLInputElement>);
  return preventDefault.mock.calls.length > 0;
}

describe("blockDecimalKey", () => {
  it("blocks the keys that would type a non-digit", () => {
    for (const key of [".", ",", "-", "+", "e", "E"]) expect(keydown(key)).toBe(true);
  });

  it("lets digits through", () => {
    expect(keydown("5")).toBe(false);
  });

  it("leaves the browser's Ctrl/Cmd shortcuts alone, zoom included", () => {
    expect(keydown("-", { ctrlKey: true })).toBe(false);
    expect(keydown("+", { metaKey: true })).toBe(false);
    expect(keydown("e", { metaKey: true })).toBe(false);
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
