import { randomUUID } from "node:crypto";

import { db } from "@ori/db";
import {
  arrangementRecords,
  companies,
  dailyArrangements,
  dailyOrderProducts,
  dailyOrders,
  dailyPickProducts,
  dailyPicks,
  productFamilies,
  productVarieties,
  tradingDays,
} from "@ori/db/schema";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Release workbook task 03 (ORI-002): every stock quantity the database keeps
// is a real number, whoever writes it.
//
// Postgres will store 'NaN' ("not a number") in a numeric column, and it sorts
// NaN above every real number — so a single NaN breaks each limit compared
// against it. A grower's pick saved as NaN once made max_orderable_for_customer
// NaN, and a customer could then order any amount of that product. Migration
// 0069 made five stock fields refuse NaN and 0070 the sixth (the end-of-day
// leftover). 'Infinity' and '-Infinity' never fit these numeric(10,2) columns.
//
// Each write goes straight to the table as its owner — past every function's
// own checks and every row-security policy — so a refusal here means no API
// call, screen or import can store the value either.
describe("stock quantities are real numbers (migrations 0069, 0070)", () => {
  it("refuses NaN, Infinity and -Infinity in all six stock fields", async () => {
    const outcomes = await inRolledBackTransaction(async (tx) => {
      const name = `בדיקת מספרי מלאי ${randomUUID()}`;
      const [grower] = await tx
        .insert(companies)
        .values({ name, type: "grower" })
        .returning({ id: companies.id });
      const [customer] = await tx
        .insert(companies)
        .values({ name, type: "customer" })
        .returning({ id: companies.id });
      const [family] = await tx
        .insert(productFamilies)
        .values({ name })
        .returning({ id: productFamilies.id });
      const [variety] = await tx
        .insert(productVarieties)
        .values({ familyId: family!.id, name, noOverbooking: "1" })
        .returning({ id: productVarieties.id });
      // A closed day never takes the single open-day slot other tests use.
      const [day] = await tx
        .insert(tradingDays)
        .values({ tradeDate: "2001-01-01", phase: "closed" })
        .returning({ id: tradingDays.id });
      const [pick] = await tx
        .insert(dailyPicks)
        .values({ tradingDayId: day!.id, growerCompanyId: grower!.id })
        .returning({ id: dailyPicks.id });
      const [pickLine] = await tx
        .insert(dailyPickProducts)
        .values({
          dailyPickId: pick!.id,
          productVarietyId: variety!.id,
          palletsPicked: "10",
          leftoverPallets: "3",
          endOfDayLeftoverPallets: "5",
        })
        .returning({ id: dailyPickProducts.id });
      const [order] = await tx
        .insert(dailyOrders)
        .values({ tradingDayId: day!.id, customerCompanyId: customer!.id })
        .returning({ id: dailyOrders.id });
      const [orderLine] = await tx
        .insert(dailyOrderProducts)
        .values({ dailyOrderId: order!.id, productVarietyId: variety!.id, palletsOrdered: "4" })
        .returning({ id: dailyOrderProducts.id });
      const [arrangement] = await tx
        .insert(dailyArrangements)
        .values({ tradingDayId: day!.id })
        .returning({ id: dailyArrangements.id });
      const [record] = await tx
        .insert(arrangementRecords)
        .values({
          dailyArrangementId: arrangement!.id,
          dailyPickProductId: pickLine!.id,
          dailyOrderProductId: orderLine!.id,
          customerCompanyId: customer!.id,
          quantityPallets: "2",
        })
        .returning({ id: arrangementRecords.id });

      // One write per stock field.
      const writes: Record<string, (to: Transaction, value: string) => Promise<unknown>> = {
        "daily_pick_products.pallets_picked": (to, value) =>
          to
            .update(dailyPickProducts)
            .set({ palletsPicked: value })
            .where(eq(dailyPickProducts.id, pickLine!.id)),
        "daily_pick_products.leftover_pallets": (to, value) =>
          to
            .update(dailyPickProducts)
            .set({ leftoverPallets: value })
            .where(eq(dailyPickProducts.id, pickLine!.id)),
        "daily_pick_products.end_of_day_leftover_pallets": (to, value) =>
          to
            .update(dailyPickProducts)
            .set({ endOfDayLeftoverPallets: value })
            .where(eq(dailyPickProducts.id, pickLine!.id)),
        "daily_order_products.pallets_ordered": (to, value) =>
          to
            .update(dailyOrderProducts)
            .set({ palletsOrdered: value })
            .where(eq(dailyOrderProducts.id, orderLine!.id)),
        "arrangement_records.quantity_pallets": (to, value) =>
          to
            .update(arrangementRecords)
            .set({ quantityPallets: value })
            .where(eq(arrangementRecords.id, record!.id)),
        "product_varieties.no_overbooking": (to, value) =>
          to
            .update(productVarieties)
            .set({ noOverbooking: value })
            .where(eq(productVarieties.id, variety!.id)),
      };
      const found: Record<string, string> = {};
      for (const [field, write] of Object.entries(writes)) {
        for (const value of ["NaN", "Infinity", "-Infinity"]) {
          found[`${field} = ${value}`] = await outcomeOf(tx, (to) => write(to, value));
        }
      }
      return found;
    });

    // 23514 = check_violation: a rule refused it (0069/0070's; for the leftover,
    // 0109's limit refuses NaN first). 22003 = numeric_value_out_of_range: an
    // infinity cannot fit numeric(10,2). "saved" would mean the value got in.
    expect(outcomes).toEqual({
      "daily_pick_products.pallets_picked = NaN": "23514",
      "daily_pick_products.pallets_picked = Infinity": "22003",
      "daily_pick_products.pallets_picked = -Infinity": "22003",
      "daily_pick_products.leftover_pallets = NaN": "23514",
      "daily_pick_products.leftover_pallets = Infinity": "22003",
      "daily_pick_products.leftover_pallets = -Infinity": "22003",
      "daily_pick_products.end_of_day_leftover_pallets = NaN": "23514",
      "daily_pick_products.end_of_day_leftover_pallets = Infinity": "22003",
      "daily_pick_products.end_of_day_leftover_pallets = -Infinity": "22003",
      "daily_order_products.pallets_ordered = NaN": "23514",
      "daily_order_products.pallets_ordered = Infinity": "22003",
      "daily_order_products.pallets_ordered = -Infinity": "22003",
      "arrangement_records.quantity_pallets = NaN": "23514",
      "arrangement_records.quantity_pallets = Infinity": "22003",
      "arrangement_records.quantity_pallets = -Infinity": "22003",
      "product_varieties.no_overbooking = NaN": "23514",
      "product_varieties.no_overbooking = Infinity": "22003",
      "product_varieties.no_overbooking = -Infinity": "22003",
    });
  });
});

// The Postgres error code a write is refused with, or "saved" if it went
// through. Each write runs in its own savepoint, so one refusal does not abort
// the transaction the others share.
async function outcomeOf(
  tx: Transaction,
  write: (to: Transaction) => Promise<unknown>,
): Promise<string> {
  try {
    await tx.transaction(async (savepoint) => {
      await write(savepoint);
    });
    return "saved";
  } catch (error) {
    return (error as { code?: string }).code ?? `threw: ${String(error)}`;
  }
}

// Runs `work` in one transaction that is always rolled back, so the fixture
// leaves nothing behind in the shared test database — not even when the test
// fails half-way. (Other domain tests delete their fixtures in afterEach; with
// ten linked tables, rolling back is simpler and cannot miss a row.)
async function inRolledBackTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  const rollBack = new Error("roll back the fixture");
  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      result = await work(tx);
      throw rollBack;
    });
  } catch (error) {
    if (error !== rollBack) throw error;
  }
  return result as T;
}
