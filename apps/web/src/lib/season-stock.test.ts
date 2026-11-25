import { describe, expect, it } from "vitest";

import { linesHoldingStock, toSeasonStockLines } from "./season-stock";

// Workbook Task 04: before a variety leaves a grower's in-season list, the
// Growers screen warns when that variety's line on today's pick still holds
// stock — pallets picked, carried in (עודף), or already arranged to customers.
describe("linesHoldingStock", () => {
  const lines = [
    { varietyId: "picked", picked: 5, leftover: 0, arranged: 0 },
    { varietyId: "carried", picked: 0, leftover: 2, arranged: 0 },
    { varietyId: "arranged", picked: 0, leftover: 0, arranged: 1.5 },
    { varietyId: "empty", picked: 0, leftover: 0, arranged: 0 },
    { varietyId: "staying", picked: 3, leftover: 0, arranged: 0 },
  ];

  it("names each variety leaving the season whose line holds picked, carried or arranged pallets", () => {
    const removed = new Set(["picked", "carried", "arranged", "empty"]);
    expect(linesHoldingStock(removed, lines).map((line) => line.varietyId)).toEqual([
      "picked",
      "carried",
      "arranged",
    ]);
  });

  it("leaves out a variety leaving the season whose line was never used", () => {
    expect(linesHoldingStock(new Set(["empty"]), lines)).toEqual([]);
  });

  it("leaves out a variety with stock that stays in the season", () => {
    expect(
      linesHoldingStock(new Set(["empty"]), lines).some((line) => line.varietyId === "staying"),
    ).toBe(false);
    expect(linesHoldingStock(new Set<string>(), lines)).toEqual([]);
  });
});

describe("toSeasonStockLines", () => {
  it("reads a pick's lines with the pallets arranged from each summed up", () => {
    expect(
      toSeasonStockLines([
        {
          product_variety_id: "v1",
          pallets_picked: 10,
          leftover_pallets: 2,
          arrangement_records: [{ quantity_pallets: 1 }, { quantity_pallets: 2.5 }],
        },
        {
          product_variety_id: "v2",
          pallets_picked: 0,
          leftover_pallets: 0,
          arrangement_records: [],
        },
      ]),
    ).toEqual([
      { varietyId: "v1", picked: 10, leftover: 2, arranged: 3.5 },
      { varietyId: "v2", picked: 0, leftover: 0, arranged: 0 },
    ]);
  });

  it("counts a missing number as no pallets", () => {
    expect(
      toSeasonStockLines([
        {
          product_variety_id: "v3",
          pallets_picked: null,
          leftover_pallets: null,
          arrangement_records: null,
        },
      ]),
    ).toEqual([{ varietyId: "v3", picked: 0, leftover: 0, arranged: 0 }]);
  });
});
