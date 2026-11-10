import { describe, expect, it } from "vitest";

import type { FlatRecord } from "./board-data";
import { sortRecords } from "./records-sort";

const record = (recordId: string, varietyLabel: string, growerName: string, customerName: string): FlatRecord => ({
  recordId,
  varietyLabel,
  growerName,
  customerName,
  quantity: 1,
  price: null,
  priceType: null,
});

// Hebrew order: אבוקדו < לימון; אברהמי < גולדי; ירקות הצפון < סופר השכונה < שוק תל אביב.
const records = [
  record("1", "לימון", "גולדי", "שוק תל אביב"),
  record("2", "אבוקדו", "אברהמי", "סופר השכונה"),
  record("3", "אבוקדו", "גולדי", "שוק תל אביב"),
  record("4", "לימון", "אברהמי", "ירקות הצפון"),
];
const ids = (sorted: FlatRecord[]) => sorted.map((r) => r.recordId);

describe("sortRecords", () => {
  it("by customer: customer name, then product — Bubble's by-customer list", () => {
    expect(ids(sortRecords(records, "by-customer"))).toEqual(["4", "2", "3", "1"]);
  });

  it("by product: product, then grower — as the table has always sorted", () => {
    expect(ids(sortRecords(records, "by-product"))).toEqual(["2", "3", "4", "1"]);
  });

  it("by grower: grower, then product — as the table has always sorted", () => {
    expect(ids(sortRecords(records, "by-grower"))).toEqual(["2", "4", "3", "1"]);
  });

  it("leaves the list it was given untouched", () => {
    const before = ids(records);
    sortRecords(records, "by-customer");
    expect(ids(records)).toEqual(before);
  });
});
