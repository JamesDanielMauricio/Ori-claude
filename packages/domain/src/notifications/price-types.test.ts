import { db } from "@ori/db";
import { PRICE_TYPE_LABELS, PRICE_TYPES } from "@ori/shared/price-type";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

// Migration 0100: the price types exist twice — the public.price_type enum
// with public.price_type_label for the closing message, and
// packages/shared/src/price-type.ts for the screens. These keep the two the
// same: the same list, in the same order, by the same names. Since 0102 the
// closing message writes a price the way Bubble's does (a range high - low),
// not the way the shop does.
describe("price types in SQL and in packages/shared (0100)", () => {
  it("the enum is PRICE_TYPES, in order, and price_type_label gives PRICE_TYPE_LABELS", async () => {
    const rows = [
      ...(await db.execute<{ code: string; label: string | null }>(sql`
        select code::text as code, public.price_type_label(code::text) as label
        from unnest(enum_range(null::public.price_type)) with ordinality as t(code, i)
        order by i
      `)),
    ];
    expect(rows.map((row) => row.code)).toEqual([...PRICE_TYPES]);
    for (const row of rows) expect(row.label, row.code).toBe(PRICE_TYPE_LABELS[row.code as keyof typeof PRICE_TYPE_LABELS]);
  });

  it("the customer's closing message writes each line's price by its type, as Bubble does (0102)", async () => {
    const lines = [
      { varietyName: "א", priceType: "fixed", price: 12.5, priceRangeFrom: 10, priceRangeTo: 14 },
      { varietyName: "ב", priceType: "range", price: 9, priceRangeFrom: 10, priceRangeTo: 12 },
      { varietyName: "ג", priceType: "record_plus_1", price: 12, priceRangeFrom: null, priceRangeTo: null },
      { varietyName: "ד", priceType: "record", price: null, priceRangeFrom: null, priceRangeTo: null },
      // A message queued before 0100 has no type: 0083's rule.
      { varietyName: "ה", priceType: null, price: 8, priceRangeFrom: null, priceRangeTo: null },
      { varietyName: "ו", priceType: null, price: null, priceRangeFrom: 3, priceRangeTo: 4 },
      // Nothing to show: no price on a מספר line, an end missing on a טווח one.
      { varietyName: "ז", priceType: "fixed", price: null, priceRangeFrom: 1, priceRangeTo: 2 },
      { varietyName: "ח", priceType: "range", price: 5, priceRangeFrom: 1, priceRangeTo: null },
    ].map((line) => ({ ...line, familyName: "משפחה", quantityPallets: 2, growerCompanyName: "מגדל" }));

    const [row] = [
      ...(await db.execute<{ text: string }>(sql`
        select public.compose_order_details_text(${JSON.stringify({ lines })}::jsonb) as text
      `)),
    ];
    // Bubble's main alert 9 line: "<family> <variety>  |  מחיר: <price>  |  כמות: <n> <grower>".
    expect(row!.text.split("\n")).toEqual([
      "משפחה א  |  מחיר: ₪12.5  |  כמות: 2 מגדל",
      "משפחה ב  |  מחיר: ₪12 - ₪10  |  כמות: 2 מגדל",
      "משפחה ג  |  מחיר: תקליט + ₪1  |  כמות: 2 מגדל",
      "משפחה ד  |  מחיר: תקליט  |  כמות: 2 מגדל",
      "משפחה ה  |  מחיר: ₪8  |  כמות: 2 מגדל",
      "משפחה ו  |  מחיר: ₪4 - ₪3  |  כמות: 2 מגדל",
      "משפחה ז  |  כמות: 2 מגדל",
      "משפחה ח  |  כמות: 2 מגדל",
    ]);
  });
});
