import { db } from "@ori/db";
import { formatPriceByType, PRICE_TYPE_LABELS, PRICE_TYPES } from "@ori/shared/price-type";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

// Migration 0100: the price types exist twice — the public.price_type enum
// with public.price_type_label for the closing message, and
// packages/shared/src/price-type.ts for the screens. These keep the two the
// same: the same list, in the same order, by the same names, and a price
// written the same way in the message as in the shop.
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

  it("the closing message writes each line's price by its type, as the shop does", async () => {
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
    const expected = lines.map((line) => {
      const price = formatPriceByType(line);
      return `משפחה — ${line.varietyName}${price ? ` — ${price}` : ""}: 2 משטחים (מגדל)`;
    });
    expect(row!.text.split("\n")).toEqual(expected);
    expect(expected.slice(0, 4)).toEqual([
      "משפחה — א — ₪12.5: 2 משטחים (מגדל)",
      "משפחה — ב — ₪10–₪12: 2 משטחים (מגדל)",
      "משפחה — ג — תקליט + ₪1: 2 משטחים (מגדל)",
      "משפחה — ד — תקליט: 2 משטחים (מגדל)",
    ]);
  });
});
