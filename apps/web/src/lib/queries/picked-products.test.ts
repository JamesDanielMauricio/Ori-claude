import { describe, expect, it } from "vitest";

import { sumStockByVariety } from "./picked-products";

// משטחים במלאי on מוצרים שנקטפו: a variety's picked + leftover pallets for the
// day, summed over every grower's pick line — Bubble's own number.
describe("sumStockByVariety", () => {
  it("adds picked and leftover across growers, without floating-point noise", () => {
    const stock = sumStockByVariety([
      { product_variety_id: "A", pallets_picked: "1.50", leftover_pallets: 0.1 },
      { product_variety_id: "A", pallets_picked: 0.2, leftover_pallets: null },
    ]);
    expect(stock.get("A")).toBe(1.8);
  });

  it("leaves out a variety with nothing picked and nothing left over", () => {
    const stock = sumStockByVariety([{ product_variety_id: "B", pallets_picked: 0, leftover_pallets: 0 }]);
    expect(stock.has("B")).toBe(false);
  });

  it("reads PostgREST's decimal strings as numbers", () => {
    const stock = sumStockByVariety([{ product_variety_id: "C", pallets_picked: "2.00", leftover_pallets: "0" }]);
    expect(stock.get("C")).toBe(2);
  });
});
