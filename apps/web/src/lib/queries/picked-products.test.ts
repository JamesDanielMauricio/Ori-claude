import { describe, expect, it } from "vitest";

import { singleSupplyLines, sumStockByVariety } from "./picked-products";

// The stock popup is offered on a product only when ONE pick line supplies it
// that day, so the number on screen is that one line's stock.
describe("singleSupplyLines", () => {
  it("keeps a variety only one line supplies", () => {
    const single = singleSupplyLines([
      // A: two lines, one with nothing -> one supplier -> kept.
      { id: "a1", daily_pick_id: "p1", product_variety_id: "A", pallets_picked: 3, leftover_pallets: 0 },
      { id: "a2", daily_pick_id: "p2", product_variety_id: "A", pallets_picked: 0, leftover_pallets: 0 },
      // B: two lines both supplying -> absent.
      { id: "b1", daily_pick_id: "p1", product_variety_id: "B", pallets_picked: 1, leftover_pallets: 0 },
      { id: "b2", daily_pick_id: "p2", product_variety_id: "B", pallets_picked: "2.00", leftover_pallets: null },
      // C: leftover-only supply counts.
      { id: "c1", daily_pick_id: "p1", product_variety_id: "C", pallets_picked: 0, leftover_pallets: "1.50" },
    ]);
    expect(single.get("A")).toBe("a1");
    expect(single.has("B")).toBe(false);
    expect(single.get("C")).toBe("c1");
  });

  it("a variety whose one supplying line is on a closed pick is absent", () => {
    const single = singleSupplyLines(
      [{ id: "a1", daily_pick_id: "p1", product_variety_id: "A", pallets_picked: 3, leftover_pallets: 0 }],
      new Set(["p1"]),
    );
    expect(single.has("A")).toBe(false);
  });

  it("a closed line still counts as a second supplier", () => {
    const single = singleSupplyLines(
      [
        { id: "a1", daily_pick_id: "p1", product_variety_id: "A", pallets_picked: 3, leftover_pallets: 0 },
        { id: "a2", daily_pick_id: "p2", product_variety_id: "A", pallets_picked: 2, leftover_pallets: 0 },
      ],
      new Set(["p2"]),
    );
    expect(single.has("A")).toBe(false);
  });
});

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
