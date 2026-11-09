import { describe, expect, it } from "vitest";

import { floorToPalletStep, isPalletQuantity, roundPallets } from "./pallets";

describe("isPalletQuantity", () => {
  it("accepts whole pallets and one decimal place", () => {
    for (const value of [0, 1, 0.1, 0.4, 2.5, 12.9, 1000]) {
      expect(isPalletQuantity(value), String(value)).toBe(true);
    }
  });

  it("refuses a second decimal place", () => {
    for (const value of [0.14, 0.05, 2.55, 1.01]) {
      expect(isPalletQuantity(value), String(value)).toBe(false);
    }
  });

  it("refuses negative and non-finite numbers", () => {
    for (const value of [-0.1, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isPalletQuantity(value), String(value)).toBe(false);
    }
  });

  it("accepts a sum of tenths, whatever JavaScript makes of it", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(isPalletQuantity(0.1 + 0.2)).toBe(true);
  });
});

describe("roundPallets", () => {
  it("takes the noise out of sums and differences", () => {
    expect(roundPallets(0.1 + 0.2)).toBe(0.3);
    expect(roundPallets(1 - 0.7 - 0.3)).toBe(0);
    expect(Object.is(roundPallets(0.7 + 0.3 - 1), 0)).toBe(true);
  });

  it("never changes a value the database could hold", () => {
    for (const value of [0, 3, 0.4, 2.65, 99_999_999.99]) {
      expect(roundPallets(value)).toBe(value);
    }
  });
});

describe("floorToPalletStep", () => {
  it("is the most that can be entered against a limit", () => {
    expect(floorToPalletStep(2.6)).toBe(2.6);
    expect(floorToPalletStep(2.65)).toBe(2.6);
    expect(floorToPalletStep(3)).toBe(3);
    expect(floorToPalletStep(0.09)).toBe(0);
  });

  it("is not thrown off by noise just under a tenth", () => {
    expect(floorToPalletStep(0.7 - 0.4)).toBe(0.3);
    expect(floorToPalletStep(1 - 0.9)).toBe(0.1);
  });
});
