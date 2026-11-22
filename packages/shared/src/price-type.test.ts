import { describe, expect, it } from "vitest";

import {
  formatPriceByType,
  parsePriceType,
  PRICE_MISSING_MESSAGE,
  PRICE_NEGATIVE_MESSAGE,
  PRICE_RANGE_MISSING_MESSAGE,
  PRICE_RANGE_ORDER_MESSAGE,
  PRICE_TYPE_LABELS,
  PRICE_TYPE_MESSAGES,
  PRICE_TYPES,
  priceTypeOf,
  priceTypeProblem,
  pricesForType,
} from "./price-type";

const noPrices = { price: null, priceRangeFrom: null, priceRangeTo: null };

describe("PRICE_TYPES", () => {
  it("is Bubble's Price Types option set, in its order, with its captions", () => {
    expect(PRICE_TYPES.map((type) => PRICE_TYPE_LABELS[type])).toEqual([
      "תקליט",
      "תקליט - ₪0.5",
      "תקליט - ₪1",
      "תקליט - ₪1.5",
      "תקליט - ₪2",
      "תקליט + ₪0.5",
      "תקליט + ₪1",
      "תקליט + ₪1.5",
      "תקליט + ₪2",
      "מספר",
      "טווח",
    ]);
  });
});

describe("parsePriceType", () => {
  it("reads every code as itself", () => {
    for (const type of PRICE_TYPES) expect(parsePriceType(type)).toBe(type);
  });

  it("reads every Bubble caption as its type — the values stored before migration 0100", () => {
    for (const type of PRICE_TYPES) expect(parsePriceType(PRICE_TYPE_LABELS[type]), type).toBe(type);
  });

  it("reads a caption whatever its spacing, shekel sign or kind of minus", () => {
    expect(parsePriceType(" תקליט -₪1 ")).toBe("record_minus_1");
    expect(parsePriceType("תקליט − 1 ש״ח")).toBe("record_minus_1");
    expect(parsePriceType("תקליט – 0.50")).toBe("record_minus_0_5");
    expect(parsePriceType("תקליט+₪1.5")).toBe("record_plus_1_5");
  });

  it("reads anything else, and nothing, as no type", () => {
    for (const value of [null, undefined, "", "  ", "לפי גודל", "תקליט + ₪3", "Fixed"]) {
      expect(parsePriceType(value), String(value)).toBeNull();
    }
  });
});

describe("priceTypeOf", () => {
  it("is a stored type, read by parsePriceType", () => {
    expect(priceTypeOf("תקליט", { ...noPrices, price: 12 })).toBe("record");
    expect(priceTypeOf("range", { ...noPrices, price: 12 })).toBe("range");
  });

  it("with no type, is what the numbers say — as migration 0100 converted them", () => {
    expect(priceTypeOf(null, { price: 8, priceRangeFrom: 10, priceRangeTo: 12 })).toBe("fixed");
    expect(priceTypeOf("לפי גודל", { price: null, priceRangeFrom: 10, priceRangeTo: 12 })).toBe("range");
    expect(priceTypeOf(null, { price: null, priceRangeFrom: 10, priceRangeTo: null })).toBeNull();
    expect(priceTypeOf("", noPrices)).toBeNull();
  });
});

describe("formatPriceByType", () => {
  it("shows a מספר product's price, and nothing else it holds", () => {
    expect(formatPriceByType({ priceType: "fixed", price: 12.5, priceRangeFrom: 10, priceRangeTo: 14 })).toBe("₪12.5");
    expect(formatPriceByType({ priceType: "fixed", ...noPrices })).toBeNull();
  });

  it("shows a טווח product's range from–to, even when it holds a price too", () => {
    expect(formatPriceByType({ priceType: "range", price: 9, priceRangeFrom: 10, priceRangeTo: 12 })).toBe("₪10–₪12");
    expect(formatPriceByType({ priceType: "range", price: 9, priceRangeFrom: 10, priceRangeTo: null })).toBeNull();
  });

  it("shows a תקליט type's own name, never a number", () => {
    expect(formatPriceByType({ priceType: "record_plus_1", price: 12, priceRangeFrom: null, priceRangeTo: null })).toBe("תקליט + ₪1");
    expect(formatPriceByType({ priceType: "record", ...noPrices })).toBe("תקליט");
  });

  it("reads a type stored as its Bubble caption", () => {
    expect(formatPriceByType({ priceType: "טווח", price: null, priceRangeFrom: 10, priceRangeTo: 12 })).toBe("₪10–₪12");
    expect(formatPriceByType({ priceType: "תקליט - ₪0.5", ...noPrices })).toBe("תקליט - ₪0.5");
  });

  it("with no type, shows the numbers there are, a fixed price first", () => {
    expect(formatPriceByType({ priceType: null, price: 8, priceRangeFrom: 10, priceRangeTo: 12 })).toBe("₪8");
    expect(formatPriceByType({ priceType: null, price: null, priceRangeFrom: 10, priceRangeTo: 12 })).toBe("₪10–₪12");
    expect(formatPriceByType({ priceType: "לפי גודל", price: 8, priceRangeFrom: null, priceRangeTo: null })).toBe("₪8");
    expect(formatPriceByType({ priceType: null, ...noPrices })).toBeNull();
  });
});

describe("pricesForType", () => {
  const all = { price: 8, priceRangeFrom: 10, priceRangeTo: 12 };

  it("keeps the price for מספר and the range for טווח", () => {
    expect(pricesForType("fixed", all)).toEqual({ price: 8, priceRangeFrom: null, priceRangeTo: null });
    expect(pricesForType("range", all)).toEqual({ price: null, priceRangeFrom: 10, priceRangeTo: 12 });
  });

  it("keeps no number for a תקליט type or for no type", () => {
    expect(pricesForType("record_minus_2", all)).toEqual(noPrices);
    expect(pricesForType(null, all)).toEqual(noPrices);
  });
});

describe("priceTypeProblem", () => {
  it("asks a מספר product for its price", () => {
    expect(priceTypeProblem("fixed", noPrices)).toBe(PRICE_MISSING_MESSAGE);
    expect(priceTypeProblem("fixed", { ...noPrices, price: 0 })).toBeNull();
  });

  it("asks a טווח product for both ends, from no higher than to", () => {
    expect(priceTypeProblem("range", { ...noPrices, priceRangeFrom: 10 })).toBe(PRICE_RANGE_MISSING_MESSAGE);
    expect(priceTypeProblem("range", { ...noPrices, priceRangeFrom: 12, priceRangeTo: 10 })).toBe(PRICE_RANGE_ORDER_MESSAGE);
    expect(priceTypeProblem("range", { ...noPrices, priceRangeFrom: 10, priceRangeTo: 10 })).toBeNull();
  });

  it("asks nothing of a תקליט type or of no type", () => {
    expect(priceTypeProblem("record", noPrices)).toBeNull();
    expect(priceTypeProblem(null, noPrices)).toBeNull();
  });

  // Found in testing (2026-11-20): a product saved with the price −5.
  it("refuses a negative price in any number the type uses", () => {
    expect(priceTypeProblem("fixed", { ...noPrices, price: -5 })).toBe(PRICE_NEGATIVE_MESSAGE);
    expect(priceTypeProblem("range", { ...noPrices, priceRangeFrom: -1, priceRangeTo: 10 })).toBe(
      PRICE_NEGATIVE_MESSAGE,
    );
    expect(priceTypeProblem("range", { ...noPrices, priceRangeFrom: -3, priceRangeTo: -1 })).toBe(
      PRICE_NEGATIVE_MESSAGE,
    );
  });

  it("ignores a negative number the type doesn't use, since it is never saved", () => {
    expect(priceTypeProblem("range", { price: -5, priceRangeFrom: 1, priceRangeTo: 2 })).toBeNull();
  });

  it("puts the negative-price message among those a screen shows as it is", () => {
    expect(PRICE_TYPE_MESSAGES).toContain(PRICE_NEGATIVE_MESSAGE);
  });
});
