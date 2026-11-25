import { randomUUID } from "node:crypto";

import { db } from "@ori/db";
import {
  companies,
  dailyPickProducts,
  dailyPicks,
  dailyShops,
  notificationOutbox,
  orderSubmissionLogs,
  productFamilies,
  productVarieties,
  profileBlockedProducts,
  profiles,
} from "@ori/db/schema";
import type { Database } from "@ori/db/supabase-types";
import {
  createAnonClient,
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
  signInTestUser,
} from "@ori/domain/auth/testing";
import {
  createTestGrowerWithProduct,
  createTestOrderProductLine,
  createTestTradingDay,
  deleteTestGrowerWithProduct,
  deleteTestTradingDay,
  getDailyPickForGrower,
} from "@ori/domain/lifecycle-engine/testing";
import { toSaveCustomerRpcArgs } from "@ori/domain/reference-data";
import {
  createTestProductFamily,
  createTestProductVariety,
  deleteTestProductFamily,
  deleteTestProductVariety,
} from "@ori/domain/reference-data/testing";
import type { SupabaseClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CUSTOMER_ERROR_CODES,
  toOrderableCatalogRpcArgs,
  toSendOrderReminderRpcArgs,
  toSubmitOrderRpcArgs,
} from "./schemas";
import {
  createTestDailyOrder,
  createTestDailyShop,
  getDailyOrderForCustomer,
  getOrderProductLine,
} from "./test-helpers";

// Every fixture trading day here is created directly at phase "shop_open",
// which — like every non-"closed" phase — participates in the
// single-open-trading-day partial unique index (0009). That's the same
// global constraint lifecycle.test.ts's own tests share, so this file
// needs the same discipline: sequential execution across test FILES
// (packages/domain/vitest.config.ts's fileParallelism: false) is what
// keeps this file's trading days from colliding with any other file's.
describe("customer ordering module", () => {
  const cleanupFns: Array<() => Promise<void>> = [];
  const adminCleanupFns: Array<() => Promise<void>> = [];
  let admin: { client: SupabaseClient<Database>; userId: string; companyId: string };

  // One shared backoffice admin for the whole file (beforeAll/afterAll),
  // not one per test the way every other module's test file does it.
  // None of these tests exercise anything admin-identity-specific — the
  // admin only ever opens a trading day and stamps a shop — so there's
  // nothing a fresh identity per test protects here. This file already
  // creates 2-3 customer identities per test (needed for genuine
  // multi-tenant assertions, e.g. the per-customer carve-out and the
  // concurrent-submission race), so cutting the other 3 of 4 admin
  // create+sign-in+delete cycles is a real reduction in the auth-service
  // load that correlates with the deleteUser flakiness documented in
  // docs/ARCHITECTURE.md's customer ordering module section — not just a
  // retry-harder mitigation (see auth/test-helpers.ts's deleteTestUser
  // pacing for that half of the fix).
  beforeAll(async () => {
    const company = await createTestCompany();
    adminCleanupFns.push(() => deleteTestCompany(company.id));
    const profile = await createTestProfile({ companyId: company.id, role: "backoffice" });
    adminCleanupFns.push(() => deleteTestUser(profile.userId));
    admin = {
      client: await signInTestUser(profile.email, profile.password),
      userId: profile.userId,
      companyId: company.id,
    };
  });

  afterAll(async () => {
    await runCleanup(adminCleanupFns);
  });

  afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  async function signedInCustomer(customerCompanyId: string) {
    const customer = await createTestProfile({ companyId: customerCompanyId, role: "customer" });
    cleanupFns.push(() => deleteTestUser(customer.userId));
    return signInTestUser(customer.email, customer.password);
  }

  // Deliberately does NOT push its own cleanup: daily_orders/daily_picks
  // rows (and everything created against them below) have no
  // ON DELETE CASCADE back to the companies they reference, so the day
  // (and everything it cascades to) must be torn down BEFORE any
  // customer/grower company created alongside it — see
  // lifecycle-engine/test-helpers.ts's createTestTradingDay and the
  // grower module's identical note. Callers push this day's own cleanup
  // last, after every other fixture created alongside it, so it runs
  // first (runCleanup is LIFO).
  //
  // This matters even more here than in the grower module: a customer who
  // successfully calls submit_order gets an order_submission_logs row
  // (submitted_by references profiles.user_id, no cascade — it's meant to
  // survive independent of the submitting user's own lifecycle). That row
  // only goes away via daily_orders' cascade, i.e. when the day is
  // deleted. Deleting that customer's own auth user/profile BEFORE the
  // day is what used to surface as an opaque profiles FK violation during
  // cleanup — pushing the day's cleanup after every sign-in that might
  // have called submit_order (not just after company creation) is the
  // actual fix, not a timing workaround. (Since migration 0073 that
  // reference is ON DELETE SET NULL, so a user is deletable before their
  // log row — the ordering is kept for the companies, which still need it.)
  async function createOpenTestDay(adminId: string) {
    const day = await createTestTradingDay({ initiatedByUserId: adminId, phase: "shop_open" });
    await createTestDailyShop({ tradingDayId: day.id, openedByUserId: adminId });
    return day;
  }

  async function createTestCustomer(tradingDayId: string) {
    const company = await createTestCompany(`לקוח בדיקה ${randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(company.id));
    await createTestDailyOrder({ tradingDayId, customerCompanyId: company.id });
    return { companyId: company.id };
  }

  async function pickLine(tradingDayId: string, growerCompanyId: string, productVarietyId: string, pallets: number) {
    const [pick] = await db.insert(dailyPicks).values({ tradingDayId, growerCompanyId }).returning();
    if (!pick) throw new Error("failed to create test daily pick");
    await db
      .insert(dailyPickProducts)
      .values({ dailyPickId: pick.id, productVarietyId, palletsPicked: pallets.toString() });
    return pick;
  }

  it("get_orderable_catalog_for_customer applies the family-survives-if-any-variety-orderable rule and the per-customer carve-out for a mixed family", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const soldOutVariety = await createTestProductVariety({
      familyId: grower.familyId,
      name: `Sold out ${randomUUID()}`,
    });
    cleanupFns.push(() => deleteTestProductVariety(soldOutVariety.id));
    const day = await createOpenTestDay(admin.userId);

    // In-stock variety: 10 picked, nobody has ordered it yet.
    const pick = await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    // Sold-out variety: 3 picked — it has picking, so it is genuinely in today's shop — and customer 2
    // orders all 3 below, so nothing is left of it.
    await db
      .insert(dailyPickProducts)
      .values({ dailyPickId: pick.id, productVarietyId: soldOutVariety.id, palletsPicked: "3" });

    // Both customer fixtures — AND their sign-ins — are created up front,
    // before any assertion runs, so this day's cleanup (pushed right
    // after, last) is registered regardless of which assertion below
    // might fail, and runs before either customer's own user delete (see
    // createOpenTestDay's comment on why that matters — client2 below
    // calls submit_order).
    const customer1 = await createTestCustomer(day.id);
    const customer2 = await createTestCustomer(day.id);
    const client1 = await signedInCustomer(customer1.companyId);
    const client2 = await signedInCustomer(customer2.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    // Customer 2 has all 3 pallets of the sold-out variety in their own order.
    // Direct-inserted rather than submitted through the RPC. The line this
    // test needs is one placed while the variety still had stock — the whole
    // point of the carve-out is that it survives the stock running out — and
    // arranging it directly also stops a test about the CATALOG's carve-out
    // from failing whenever submit_order's own rules change.
    await createTestOrderProductLine(day.id, customer2.companyId, soldOutVariety.id, 3);

    // Customer 1: empty order. Should see the in-stock variety and NOT the
    // sold-out one — but the family itself must still appear (via the
    // in-stock variety), never dropped wholesale.
    const catalog1 = await client1.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id }),
    );
    expect(catalog1.error).toBeNull();
    const family1Rows = catalog1.data!.filter((row) => row.family_id === grower.familyId);
    expect(family1Rows).toHaveLength(1);
    expect(family1Rows[0]).toMatchObject({
      variety_id: grower.varietyId,
      is_orderable: true,
      pallets_ordered: 0,
    });

    // Customer 2: the carve-out means THEY still see the sold-out variety —
    // is_orderable: false, but present, with their 3 pallets — while the
    // in-stock variety is also present on its own merits. Neither customer's
    // view affects the other's.
    const catalog2 = await client2.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id }),
    );
    expect(catalog2.error).toBeNull();
    const family2Rows = catalog2.data!.filter((row) => row.family_id === grower.familyId);
    expect(family2Rows).toHaveLength(2);
    expect(family2Rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variety_id: grower.varietyId,
          is_orderable: true,
          pallets_ordered: 0,
        }),
        expect.objectContaining({
          variety_id: soldOutVariety.id,
          is_orderable: false,
          pallets_ordered: 3,
        }),
      ]),
    );

    // Customer 1's own view is unaffected by customer 2's carve-out — the
    // sold-out variety still doesn't show for them.
    const catalog1Again = await client1.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id }),
    );
    expect(catalog1Again.data!.some((row) => row.variety_id === soldOutVariety.id)).toBe(false);

    // A distributor is shown fully ordered products too (customers are not): reading customer 1's
    // catalog as backoffice lists the sold-out variety, flagged not orderable.
    const staffCatalog = await admin.client.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id, customerCompanyId: customer1.companyId }),
    );
    expect(staffCatalog.error).toBeNull();
    const staffRows = staffCatalog.data!.filter((row) => row.family_id === grower.familyId);
    expect(staffRows).toHaveLength(2);
    expect(staffRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variety_id: grower.varietyId, is_orderable: true }),
        expect.objectContaining({
          variety_id: soldOutVariety.id,
          is_orderable: false,
          pallets_ordered: 0,
        }),
      ]),
    );
  }, 30000);

  it("get_orderable_catalog_for_customer shows customers only products that have picking and are not fully ordered (an overbooking allowance never counts), and shows distributors every product that has picking", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    // One extra variety per case, all in the same family as the grower's own.
    const extraVariety = async (label: string) => {
      const variety = await createTestProductVariety({
        familyId: grower.familyId,
        name: `${label} ${randomUUID()}`,
      });
      cleanupFns.push(() => deleteTestProductVariety(variety.id));
      return variety;
    };
    const leftoverOnly = await extraVariety("Leftover only");
    const overbookingOnly = await extraVariety("Overbooking only");
    const fullyOrdered = await extraVariety("Fully ordered");
    const emptiedAfterOrder = await extraVariety("Ordered, picking since 0");
    const day = await createOpenTestDay(admin.userId);

    // grower.varietyId: 10 pallets picked — has picking.
    const pick = await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    // Leftover only: nothing picked today, 4 pallets carried over. Leftover IS picking.
    await db.insert(dailyPickProducts).values({
      dailyPickId: pick.id,
      productVarietyId: leftoverOnly.id,
      palletsPicked: "0",
      leftoverPallets: "4",
    });
    // Overbooking only: no picking and no leftover, but an overbooking allowance of 3. That alone used
    // to be enough (0 + 0 + 3 > 0) to list it to every customer and let them order up to 3 pallets.
    await db
      .insert(dailyPickProducts)
      .values({ dailyPickId: pick.id, productVarietyId: overbookingOnly.id, palletsPicked: "0" });
    await db
      .update(productVarieties)
      .set({ noOverbooking: "3" })
      .where(eq(productVarieties.id, overbookingOnly.id));
    // Fully ordered: 3 picked, and customer 2 orders all 3 below. It has picking, so it is in the shop —
    // there is just nothing left of it.
    await db
      .insert(dailyPickProducts)
      .values({ dailyPickId: pick.id, productVarietyId: fullyOrdered.id, palletsPicked: "3" });
    // A product customer 2 ordered while it had stock and whose picking has since dropped to 0.
    await db
      .insert(dailyPickProducts)
      .values({ dailyPickId: pick.id, productVarietyId: emptiedAfterOrder.id, palletsPicked: "0" });

    // Fixtures and sign-ins first, the day's cleanup last — see the first test in this file.
    const customer1 = await createTestCustomer(day.id);
    const customer2 = await createTestCustomer(day.id);
    const client1 = await signedInCustomer(customer1.companyId);
    const client2 = await signedInCustomer(customer2.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));
    await createTestOrderProductLine(day.id, customer2.companyId, fullyOrdered.id, 3);
    await createTestOrderProductLine(day.id, customer2.companyId, emptiedAfterOrder.id, 2);

    const listedFor = async (client: SupabaseClient<Database>, customerCompanyId?: string) => {
      const catalog = await client.rpc(
        "get_orderable_catalog_for_customer",
        toOrderableCatalogRpcArgs({ tradingDayId: day.id, customerCompanyId }),
      );
      expect(catalog.error).toBeNull();
      return catalog
        .data!.filter((row) => row.family_id === grower.familyId)
        .map((row) => row.variety_id);
    };

    // Customer 1, empty order: only what has picking AND still has room. Not the overbooking-only
    // product, not the fully ordered one, and not the one whose picking dropped to 0.
    const listed1 = await listedFor(client1);
    expect(listed1).toHaveLength(2);
    expect(listed1).toEqual(expect.arrayContaining([grower.varietyId, leftoverOnly.id]));

    // Customer 2: the fully ordered product stays on their screen — it has picking and it is their own
    // order, so they can still see and change it. The product whose picking dropped to 0 does NOT,
    // although it is in their order: a product with no picking is not part of the shop. (Because the
    // order screen sends back only the rows it shows and submit_order removes any line that isn't sent,
    // their next save removes that line. That is decided behaviour, not an accident.)
    const listed2 = await listedFor(client2);
    expect(listed2).toHaveLength(3);
    expect(listed2).toEqual(
      expect.arrayContaining([grower.varietyId, leftoverOnly.id, fullyOrdered.id]),
    );

    // A distributor (backoffice) reading customer 1's list is shown every product that has picking —
    // fully ordered ones too — but still not the overbooking-only product, and not customer 2's
    // zero-picking line, which is not in customer 1's order.
    const staff1 = await listedFor(admin.client, customer1.companyId);
    expect(staff1).toHaveLength(3);
    expect(staff1).toEqual(
      expect.arrayContaining([grower.varietyId, leftoverOnly.id, fullyOrdered.id]),
    );

    // Reading customer 2's list also shows their zero-picking line, so a save from the distributor's
    // screen can never remove a line the distributor cannot see.
    const staff2 = await listedFor(admin.client, customer2.companyId);
    expect(staff2).toHaveLength(4);
    expect(staff2).toEqual(
      expect.arrayContaining([
        grower.varietyId,
        leftoverOnly.id,
        fullyOrdered.id,
        emptiedAfterOrder.id,
      ]),
    );

    // The moment a grower picks 1 pallet of the overbooking-only product it appears — and it can be
    // ordered up to picking + overbooking (1 + 3), which is what the overbooking allowance is for.
    await db
      .update(dailyPickProducts)
      .set({ palletsPicked: "1" })
      .where(
        and(
          eq(dailyPickProducts.dailyPickId, pick.id),
          eq(dailyPickProducts.productVarietyId, overbookingOnly.id),
        ),
      );
    const afterPick = await client1.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id }),
    );
    expect(afterPick.error).toBeNull();
    expect(afterPick.data!.find((row) => row.variety_id === overbookingOnly.id)).toMatchObject({
      is_orderable: true,
      max_orderable_for_customer: 4,
    });
  }, 45000);

  // Workbook Task 35 (migration 0085): a customer may order part of a
  // pallet, to one decimal place, and nothing finer.
  // Migration 0090: a customer user set to a category sees only that
  // category's families and the "both" ones; staff see everything.
  it("get_orderable_catalog_for_customer shows a customer user only their category and both (migration 0090), and staff everything", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const fruitFamily = await createTestProductFamily();
    cleanupFns.push(() => deleteTestProductFamily(fruitFamily.id));
    const fruit = await createTestProductVariety({ familyId: fruitFamily.id });
    cleanupFns.push(() => deleteTestProductVariety(fruit.id));
    await db.update(productFamilies).set({ category: "vegetable" }).where(eq(productFamilies.id, grower.familyId));
    await db.update(productFamilies).set({ category: "fruit" }).where(eq(productFamilies.id, fruitFamily.id));

    const day = await createOpenTestDay(admin.userId);
    const pick = await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    await db.insert(dailyPickProducts).values({ dailyPickId: pick.id, productVarietyId: fruit.id, palletsPicked: "10" });
    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));
    await db.update(profiles).set({ productCategory: "vegetable" }).where(eq(profiles.companyId, customer.companyId));

    const own = await client.rpc("get_orderable_catalog_for_customer", toOrderableCatalogRpcArgs({ tradingDayId: day.id }));
    expect(own.error).toBeNull();
    const ownVarieties = (own.data ?? []).map((row) => row.variety_id);
    expect(ownVarieties).toContain(grower.varietyId);
    expect(ownVarieties).not.toContain(fruit.id);

    const staff = await admin.client.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id, customerCompanyId: customer.companyId }),
    );
    expect(staff.error).toBeNull();
    expect((staff.data ?? []).map((row) => row.variety_id)).toEqual(expect.arrayContaining([grower.varietyId, fruit.id]));
  }, 45000);

  // Migration 0088: a user of an inactive company is refused everything, and
  // the app can tell them why.
  it("a user of an inactive company cannot open the shop, and reads as inactive (migration 0088)", async () => {
    const day = await createOpenTestDay(admin.userId);
    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    expect((await client.rpc("my_account_is_active")).data).toBe(true);
    await db.update(companies).set({ status: "inactive" }).where(eq(companies.id, customer.companyId));
    expect((await client.rpc("my_account_is_active")).data).toBe(false);
    const refused = await client.rpc("get_orderable_catalog_for_customer", toOrderableCatalogRpcArgs({ tradingDayId: day.id }));
    expect(refused.error?.code).toBe(CUSTOMER_ERROR_CODES.FORBIDDEN);
  }, 45000);

  it("submit_order takes 0.4 of a pallet and refuses 0.14, changing nothing", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 20);
    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const tenth = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 0.4, comment: null }],
      }),
    );
    expect(tenth.error).toBeNull();
    const order = await getDailyOrderForCustomer(day.id, customer.companyId);
    expect(await getOrderProductLine(order!.id, grower.varietyId)).toMatchObject({ palletsOrdered: "0.40" });

    const finer = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 0.14, comment: null }],
      }),
    );
    expect(finer.error?.code).toBe(CUSTOMER_ERROR_CODES.INVALID_INPUT);
    expect(await getOrderProductLine(order!.id, grower.varietyId)).toMatchObject({ palletsOrdered: "0.40" });
  }, 45000);

  it("submit_order is one transaction — upserts, prunes lines omitted from the new submission, stamps submission, and logs exactly one audit row per call", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const secondVariety = await createTestProductVariety({ familyId: grower.familyId });
    cleanupFns.push(() => deleteTestProductVariety(secondVariety.id));
    const day = await createOpenTestDay(admin.userId);

    const pick = await pickLine(day.id, grower.companyId, grower.varietyId, 20);
    await db
      .insert(dailyPickProducts)
      .values({ dailyPickId: pick.id, productVarietyId: secondVariety.id, palletsPicked: "20" });

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const first = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [
          { productVarietyId: grower.varietyId, palletsOrdered: 4, comment: "first batch" },
          { productVarietyId: secondVariety.id, palletsOrdered: 2, comment: null },
        ],
      }),
    );
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ status: "submitted" });
    expect(first.data!.submitted_at).not.toBeNull();

    const orderAfterFirst = await getDailyOrderForCustomer(day.id, customer.companyId);
    const lineA = await getOrderProductLine(orderAfterFirst!.id, grower.varietyId);
    const lineB = await getOrderProductLine(orderAfterFirst!.id, secondVariety.id);
    expect(lineA).toMatchObject({ palletsOrdered: "4.00", comment: "first batch" });
    expect(lineB).toMatchObject({ palletsOrdered: "2.00" });

    // Second submission omits the second variety entirely (customer
    // zeroed it out in their draft) and changes the first — this must
    // prune the omitted line, not just leave it stale.
    const second = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 7, comment: "revised" }],
      }),
    );
    expect(second.error).toBeNull();

    const lineAAfter = await getOrderProductLine(orderAfterFirst!.id, grower.varietyId);
    const lineBAfter = await getOrderProductLine(orderAfterFirst!.id, secondVariety.id);
    expect(lineAAfter).toMatchObject({ palletsOrdered: "7.00", comment: "revised" });
    expect(lineBAfter).toBeNull();

    const logs = await db
      .select()
      .from(orderSubmissionLogs)
      .where(eq(orderSubmissionLogs.dailyOrderId, orderAfterFirst!.id));
    expect(logs).toHaveLength(2);
  }, 30000);

  it("submit_order rejects a closed trading day, a variety outside today's shop, a negative pallet count, and a non-customer caller", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const outsideVariety = await createTestProductVariety({ familyId: grower.familyId });
    cleanupFns.push(() => deleteTestProductVariety(outsideVariety.id));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const negative = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: -1, comment: null }],
      }),
    );
    expect(negative.error).not.toBeNull();
    expect(negative.error?.code).toBe(CUSTOMER_ERROR_CODES.INVALID_INPUT);

    const outside = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: outsideVariety.id, palletsOrdered: 1, comment: null }],
      }),
    );
    expect(outside.error).not.toBeNull();
    expect(outside.error?.code).toBe(CUSTOMER_ERROR_CODES.INVALID_INPUT);

    const growerCompany = await createTestCompany(`מגדל קורא לבדיקה ${randomUUID()}`, "grower");
    cleanupFns.push(() => deleteTestCompany(growerCompany.id));
    const growerUser = await createTestProfile({ companyId: growerCompany.id, role: "grower" });
    cleanupFns.push(() => deleteTestUser(growerUser.userId));
    const growerSession = await signInTestUser(growerUser.email, growerUser.password);
    const forbidden = await growerSession.rpc("submit_order", toSubmitOrderRpcArgs({ tradingDayId: day.id, lines: [] }));
    expect(forbidden.error).not.toBeNull();
    expect(forbidden.error?.code).toBe(CUSTOMER_ERROR_CODES.FORBIDDEN);

    await admin.client.from("trading_days").update({ phase: "closed" }).eq("id", day.id);
    const closed = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 1, comment: null }],
      }),
    );
    expect(closed.error).not.toBeNull();
    expect(closed.error?.code).toBe(CUSTOMER_ERROR_CODES.INVALID_STATE);
  }, 30000);

  it("concurrent submissions from two different customers against a depleting variety both succeed independently, and the resulting demand reflects both", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    // Total supply: 7, which the two orders below (3 + 4) consume exactly.
    //
    // Deliberately exact rather than the oversubscription this used to set
    // up (supply 5 against the same 3 + 4). Since migration 0042 a direct
    // customer submission may not exceed max_orderable_for_customer —
    // (supply + overbooking) minus every OTHER customer's demand — so under
    // supply 5 whichever of these two committed second was refused with
    // P0008 and the test failed on whichever order the race happened to
    // take. At supply 7 both fit in either order (7-0 ≥ 4, then 7-4 ≥ 3, and
    // vice versa), so the concurrency claim this test exists to make is the
    // only thing left that can fail it. Demand still lands exactly on
    // supply, which is what the observer assertion below needs.
    await pickLine(day.id, grower.companyId, grower.varietyId, 7);

    const customerA = await createTestCustomer(day.id);
    const clientA = await signedInCustomer(customerA.companyId);
    const customerB = await createTestCustomer(day.id);
    const clientB = await signedInCustomer(customerB.companyId);
    const observer = await createTestCustomer(day.id);
    cleanupFns.push(() => deleteTestTradingDay(day.id));
    const clientObserver = await signedInCustomer(observer.companyId);

    const [resultA, resultB] = await Promise.all([
      clientA.rpc(
        "submit_order",
        toSubmitOrderRpcArgs({
          tradingDayId: day.id,
          lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 3, comment: null }],
        }),
      ),
      clientB.rpc(
        "submit_order",
        toSubmitOrderRpcArgs({
          tradingDayId: day.id,
          lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 4, comment: null }],
        }),
      ),
    ]);

    expect(resultA.error).toBeNull();
    expect(resultB.error).toBeNull();

    const orderA = await getDailyOrderForCustomer(day.id, customerA.companyId);
    const orderB = await getDailyOrderForCustomer(day.id, customerB.companyId);
    const lineA = await getOrderProductLine(orderA!.id, grower.varietyId);
    const lineB = await getOrderProductLine(orderB!.id, grower.varietyId);
    expect(lineA).toMatchObject({ palletsOrdered: "3.00" });
    expect(lineB).toMatchObject({ palletsOrdered: "4.00" });

    // A third party with no cart of their own sees the combined demand
    // (3 + 4 = 7 > 5 supply): no longer orderable. If either concurrent
    // write had been lost, this would incorrectly still read as in stock.
    const observerCatalog = await clientObserver.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id }),
    );
    expect(observerCatalog.error).toBeNull();
    const varietyRow = observerCatalog.data!.find((row) => row.variety_id === grower.varietyId);
    expect(varietyRow).toBeUndefined();

    // The distributor still sees it: fully ordered products are hidden from customers, not from staff.
    const staffCatalog = await admin.client.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id, customerCompanyId: observer.companyId }),
    );
    expect(staffCatalog.error).toBeNull();
    expect(staffCatalog.data!.find((row) => row.variety_id === grower.varietyId)).toMatchObject({
      is_orderable: false,
    });
  }, 30000);

  it("get_orderable_catalog_for_customer and submit_order let backoffice act on a customer's behalf, but reject the same parameter from a customer", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    // Backoffice reads the customer's own catalog+cart view by supplying
    // their company id explicitly — the same computation the customer's
    // own screen gets from omitting it.
    const backofficeCatalog = await admin.client.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id, customerCompanyId: customer.companyId }),
    );
    expect(backofficeCatalog.error).toBeNull();
    const row = backofficeCatalog.data!.find((r) => r.variety_id === grower.varietyId);
    expect(row).toMatchObject({ is_orderable: true, pallets_ordered: 0 });

    // A customer supplying a company id at all — even their own — is
    // rejected outright; the parameter is backoffice-only, not merely
    // RLS-filtered.
    const spoofAttempt = await client.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id, customerCompanyId: customer.companyId }),
    );
    expect(spoofAttempt.error).not.toBeNull();
    expect(spoofAttempt.error?.code).toBe(CUSTOMER_ERROR_CODES.FORBIDDEN);

    // Backoffice submits an order on the customer's behalf through the
    // exact same submit_order the customer's own screen calls.
    const backofficeSubmit = await admin.client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 5, comment: "placed by distributor" }],
        customerCompanyId: customer.companyId,
      }),
    );
    expect(backofficeSubmit.error).toBeNull();
    expect(backofficeSubmit.data).toMatchObject({ status: "submitted" });

    const order = await getDailyOrderForCustomer(day.id, customer.companyId);
    const line = await getOrderProductLine(order!.id, grower.varietyId);
    expect(line).toMatchObject({ palletsOrdered: "5.00", comment: "placed by distributor" });

    // The audit log attributes the write to whoever actually called it —
    // the backoffice user, not the customer whose order it is.
    const [log] = await db
      .select()
      .from(orderSubmissionLogs)
      .where(eq(orderSubmissionLogs.dailyOrderId, order!.id));
    expect(log).toMatchObject({ submittedBy: admin.userId });

    // A customer supplying a company id on submit_order — even their own
    // — is rejected the same way.
    const submitSpoof = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 1, comment: null }],
        customerCompanyId: customer.companyId,
      }),
    );
    expect(submitSpoof.error).not.toBeNull();
    expect(submitSpoof.error?.code).toBe(CUSTOMER_ERROR_CODES.FORBIDDEN);
  }, 30000);

  // Workbook Task 09: a send replaces the whole order, so a screen that missed
  // a change used to erase it — the live browser test of 2026-11-24 saw the
  // office's added line deleted by a customer's next send. Each send now says
  // what its screen showed as saved (basedOn, read the way the order screens
  // read it), and is refused when that has changed since.
  it("submit_order (migration 0111): a screen that missed a change is refused instead of erasing it — the line the office added survives, and a fresh screen saves", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const otherGrower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(otherGrower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    await pickLine(day.id, otherGrower.companyId, otherGrower.varietyId, 10);
    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    // What a screen shows as saved: variety -> pallets, from the order catalog.
    async function screenBase(reader: SupabaseClient<Database>, customerCompanyId?: string) {
      const { data, error } = await reader.rpc(
        "get_orderable_catalog_for_customer",
        toOrderableCatalogRpcArgs({ tradingDayId: day.id, customerCompanyId }),
      );
      if (error) throw error;
      return Object.fromEntries(data!.map((row) => [row.variety_id, Number(row.pallets_ordered)]));
    }
    const line = (productVarietyId: string, palletsOrdered: number) => ({ productVarietyId, palletsOrdered, comment: null });

    const first = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({ tradingDayId: day.id, lines: [line(grower.varietyId, 2)], basedOn: await screenBase(client) }),
    );
    expect(first.error).toBeNull();

    // The customer's screen reads the order now ... the office adds a line ...
    const staleScreen = await screenBase(client);
    const officeAdds = await admin.client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        customerCompanyId: customer.companyId,
        lines: [line(grower.varietyId, 2), line(otherGrower.varietyId, 3)],
        basedOn: await screenBase(admin.client, customer.companyId),
      }),
    );
    expect(officeAdds.error).toBeNull();

    // ... and the customer sends from the screen that never saw it.
    const staleSend = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({ tradingDayId: day.id, lines: [line(grower.varietyId, 4)], basedOn: staleScreen }),
    );
    expect(staleSend.error?.code).toBe(CUSTOMER_ERROR_CODES.CONFLICT);
    const order = await getDailyOrderForCustomer(day.id, customer.companyId);
    expect((await getOrderProductLine(order!.id, grower.varietyId))?.palletsOrdered).toBe("2.00");
    expect((await getOrderProductLine(order!.id, otherGrower.varietyId))?.palletsOrdered).toBe("3.00");

    // A screen that read the order as it is now saves, as before.
    const freshSend = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [line(grower.varietyId, 4), line(otherGrower.varietyId, 3)],
        basedOn: await screenBase(client),
      }),
    );
    expect(freshSend.error).toBeNull();
    expect((await getOrderProductLine(order!.id, grower.varietyId))?.palletsOrdered).toBe("4.00");
  }, 30000);

  it("send_order_reminder stamps reminder_sent_at and dispatches one order_reminder outbox row, backoffice-only, and rejects an already-submitted order", async () => {
    const day = await createOpenTestDay(admin.userId);
    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const order = await getDailyOrderForCustomer(day.id, customer.companyId);

    const forbidden = await client.rpc("send_order_reminder", toSendOrderReminderRpcArgs({ dailyOrderId: order!.id }));
    expect(forbidden.error).not.toBeNull();
    expect(forbidden.error?.code).toBe(CUSTOMER_ERROR_CODES.FORBIDDEN);

    const result = await admin.client.rpc(
      "send_order_reminder",
      toSendOrderReminderRpcArgs({ dailyOrderId: order!.id }),
    );
    expect(result.error).toBeNull();
    expect(result.data!.reminder_sent_at).not.toBeNull();

    const outboxRows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, customer.companyId));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      templateKey: "order_reminder",
      recipientType: "customer",
      tradingDayId: day.id,
    });

    // Once the order is submitted, a reminder no longer makes sense —
    // empty lines is enough to trip submit_order's own status transition
    // without needing a real in-shop variety.
    const submit = await client.rpc("submit_order", toSubmitOrderRpcArgs({ tradingDayId: day.id, lines: [] }));
    expect(submit.error).toBeNull();

    const afterSubmit = await admin.client.rpc(
      "send_order_reminder",
      toSendOrderReminderRpcArgs({ dailyOrderId: order!.id }),
    );
    expect(afterSubmit.error).not.toBeNull();
    expect(afterSubmit.error?.code).toBe(CUSTOMER_ERROR_CODES.INVALID_STATE);
  }, 30000);

  // Migration 0104: the office can name which of the customer's people get the
  // reminder. The list is stored on the queued row; the dispatch reads it.
  async function customerWithTwoPeople(dayId: string) {
    const customer = await createTestCustomer(dayId);
    const a = await createTestProfile({ companyId: customer.companyId, role: "customer" });
    cleanupFns.push(() => deleteTestUser(a.userId));
    const b = await createTestProfile({ companyId: customer.companyId, role: "customer" });
    cleanupFns.push(() => deleteTestUser(b.userId));
    const order = await getDailyOrderForCustomer(dayId, customer.companyId);
    return { customer, a, b, orderId: order!.id };
  }

  it("send_order_reminder with a list stores it on the queued row and queues one row", async () => {
    const day = await createOpenTestDay(admin.userId);
    const { customer, b, orderId } = await customerWithTwoPeople(day.id);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const result = await admin.client.rpc(
      "send_order_reminder",
      toSendOrderReminderRpcArgs({ dailyOrderId: orderId, recipientUserIds: [b.userId] }),
    );
    expect(result.error).toBeNull();
    expect(result.data!.reminder_sent_at).not.toBeNull();

    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, customer.companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ templateKey: "order_reminder", recipientUserIds: [b.userId] });
  }, 30000);

  it("send_order_reminder refuses an empty list", async () => {
    const day = await createOpenTestDay(admin.userId);
    const { customer, orderId } = await customerWithTwoPeople(day.id);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    // Straight to the RPC: the domain schema already refuses an empty list,
    // so this proves the database refuses it too.
    const result = await admin.client.rpc("send_order_reminder", {
      p_daily_order_id: orderId,
      p_recipient_user_ids: [],
    });
    expect(result.error?.code).toBe("P0008");
    expect(result.error?.message).toMatch(/^INVALID_INPUT: choose at least one recipient/);

    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, customer.companyId));
    expect(rows).toHaveLength(0);
    const order = await getDailyOrderForCustomer(day.id, customer.companyId);
    expect(order!.reminderSentAt).toBeNull();
  }, 30000);

  it("send_order_reminder refuses a recipient who is not a user of this customer", async () => {
    const day = await createOpenTestDay(admin.userId);
    const { customer, orderId } = await customerWithTwoPeople(day.id);
    const otherCompany = await createTestCompany(`לקוח אחר ${randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(otherCompany.id));
    const stranger = await createTestProfile({ companyId: otherCompany.id, role: "customer" });
    cleanupFns.push(() => deleteTestUser(stranger.userId));
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const result = await admin.client.rpc(
      "send_order_reminder",
      toSendOrderReminderRpcArgs({ dailyOrderId: orderId, recipientUserIds: [stranger.userId] }),
    );
    expect(result.error?.code).toBe("P0008");
    expect(result.error?.message).toMatch(/^INVALID_INPUT: a recipient is not a user of this customer/);

    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, customer.companyId));
    expect(rows).toHaveLength(0);
  }, 30000);

  it("send_order_reminder: duplicates in the list are sent once", async () => {
    const day = await createOpenTestDay(admin.userId);
    const { customer, a, orderId } = await customerWithTwoPeople(day.id);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    // Straight to the RPC: the domain schema refuses duplicates client-side.
    const result = await admin.client.rpc("send_order_reminder", {
      p_daily_order_id: orderId,
      p_recipient_user_ids: [a.userId, a.userId],
    });
    expect(result.error).toBeNull();

    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, customer.companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientUserIds).toEqual([a.userId]);
  }, 30000);

  it("submit_order enqueues order_submitted to backoffice only on a direct customer submission, not the backoffice-on-behalf-of path — id 6", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    // Backoffice submitting on the customer's behalf must NOT self-notify.
    const backofficeSubmit = await admin.client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 2, comment: null }],
        customerCompanyId: customer.companyId,
      }),
    );
    expect(backofficeSubmit.error).toBeNull();
    const afterBackofficeSubmit = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, admin.companyId));
    expect(afterBackofficeSubmit).toHaveLength(0);

    // The customer submitting their own order does notify backoffice.
    const customerSubmit = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 3, comment: null }],
      }),
    );
    expect(customerSubmit.error).toBeNull();

    const afterCustomerSubmit = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, admin.companyId));
    expect(afterCustomerSubmit).toHaveLength(1);
    expect(afterCustomerSubmit[0]).toMatchObject({
      templateKey: "order_submitted",
      recipientType: "backoffice",
      tradingDayId: day.id,
    });

    // 0102: the message carries the order and who sent it, and goes out as
    // Bubble's main alert 6 — the order as it stands when it is sent.
    const order = await getDailyOrderForCustomer(day.id, customer.companyId);
    expect(afterCustomerSubmit[0]!.payload).toMatchObject({ dailyOrderId: order!.id, submittedByName: "משתמש בדיקה" });
    const [office] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, admin.companyId));
    const [customerCompany] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, customer.companyId));
    const preview = await admin.client.rpc("resolve_outbox_preview", { p_outbox_id: afterCustomerSubmit[0]!.id });
    expect(preview.error).toBeNull();
    expect(preview.data).toBe(
      `שלום ${office!.name}. \n${customerCompany!.name} שלחו הזמנה על ידי משתמש בדיקה.\nלהלן מצב ההזמנה הנוכחי שלהם:\n\n` +
        `${grower.familyName} ${grower.varietyName}  |  כמות: 3 \n\n\nhttps://ori-claude-web.vercel.app/backoffice/distributor-customer`,
    );
  }, 30000);

  // Migration 0107 (design 2026-11-16, row 6): in Bubble the customer user who
  // sends an order gets the same text privately, as well as the office. The
  // copy is its own message type (order_submitted_copy) so the office log can
  // name it, and its row lists the one person it is for (0104).
  async function customerWithPhone(customerCompanyId: string, phoneNumber?: string) {
    const person = await createTestProfile({
      companyId: customerCompanyId,
      role: "customer",
      displayName: "אילנה כהן",
      ...(phoneNumber === undefined ? {} : { phoneNumber }),
    });
    cleanupFns.push(() => deleteTestUser(person.userId));
    const client = await signInTestUser(person.email, person.password);
    return { client, userId: person.userId };
  }

  async function customerRows(dayId: string, customerCompanyId: string) {
    return db
      .select()
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.tradingDayId, dayId), eq(notificationOutbox.recipientCompanyId, customerCompanyId)));
  }

  it("a customer's own submit also queues a private copy for that customer user — id 6", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    const customer = await createTestCustomer(day.id);
    // A group on the customer company: the copy must still go to the person only.
    await db.update(companies).set({ whatsappGroupId: `grp-${randomUUID()}` }).where(eq(companies.id, customer.companyId));
    const orderer = await customerWithPhone(customer.companyId, "050-111 1111");
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const submit = await orderer.client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 3, comment: null }],
      }),
    );
    expect(submit.error).toBeNull();

    const office = await db
      .select()
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.recipientCompanyId, admin.companyId), eq(notificationOutbox.templateKey, "order_submitted")));
    expect(office).toHaveLength(1);
    const copies = await customerRows(day.id, customer.companyId);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      templateKey: "order_submitted_copy",
      recipientType: "customer",
      recipientCompanyId: customer.companyId,
      recipientUserIds: [orderer.userId],
    });
    expect(copies[0]!.payload).toEqual(office[0]!.payload);

    const resolved = await admin.client.rpc("resolve_outbox_dispatch", { p_outbox_id: copies[0]!.id });
    expect(resolved.error).toBeNull();
    expect((resolved.data ?? []).map((t) => ({ target: t.target, is_group: t.is_group }))).toEqual([
      { target: "972501111111", is_group: false },
    ]);
  }, 30000);

  it("the office ordering for a customer queues no copy", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    const customer = await createTestCustomer(day.id);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const submit = await admin.client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 2, comment: null }],
        customerCompanyId: customer.companyId,
      }),
    );
    expect(submit.error).toBeNull();

    const rows = await db.select().from(notificationOutbox).where(eq(notificationOutbox.tradingDayId, day.id));
    expect(rows.filter((row) => row.templateKey === "order_submitted_copy")).toHaveLength(0);
    expect(rows.filter((row) => row.templateKey === "order_submitted")).toHaveLength(0);
  }, 30000);

  it("copies are capped like the office message", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    const customer = await createTestCustomer(day.id);
    const orderer = await customerWithPhone(customer.companyId, "050-111 1111");
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    for (const pallets of [1, 2, 3, 4, 5, 6]) {
      const submit = await orderer.client.rpc(
        "submit_order",
        toSubmitOrderRpcArgs({
          tradingDayId: day.id,
          lines: [{ productVarietyId: grower.varietyId, palletsOrdered: pallets, comment: null }],
        }),
      );
      expect(submit.error).toBeNull();
    }

    const copies = (await customerRows(day.id, customer.companyId)).filter((row) => row.templateKey === "order_submitted_copy");
    expect(copies).toHaveLength(5);
  }, 60000);

  it("a copy for an orderer with no usable phone reaches nobody", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    const customer = await createTestCustomer(day.id);
    const orderer = await customerWithPhone(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const submit = await orderer.client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 3, comment: null }],
      }),
    );
    expect(submit.error).toBeNull();

    const copies = await customerRows(day.id, customer.companyId);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.templateKey).toBe("order_submitted_copy");
    const resolved = await admin.client.rpc("resolve_outbox_dispatch", { p_outbox_id: copies[0]!.id });
    expect(resolved.error).toBeNull();
    expect(resolved.data).toEqual([]);

    const office = await db
      .select()
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.recipientCompanyId, admin.companyId), eq(notificationOutbox.templateKey, "order_submitted")));
    expect(office).toHaveLength(1);
  }, 30000);

  it("submit_order enqueues stock_overbooking_reached exactly when demand crosses from under-supply to at-or-over-supply while overbooking room remains — id 10", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    // Supply 10, overbooking 5 — orderable while demand < 15.
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    await db.update(productVarieties).set({ noOverbooking: "5" }).where(eq(productVarieties.id, grower.varietyId));

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    // Demand 0 -> 4: stays well under supply, no crossing. (Every direct
    // customer submission also enqueues an unrelated order_submitted row,
    // id 6 — filtering by templateKey isolates this trigger from that
    // one, not just by recipientCompanyId.)
    const underSupply = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 4, comment: null }],
      }),
    );
    expect(underSupply.error).toBeNull();
    const afterUnderSupply = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, admin.companyId));
    expect(afterUnderSupply.filter((row) => row.templateKey === "stock_overbooking_reached")).toHaveLength(0);

    // Demand 4 -> 10: crosses base supply while overbooking room (5) remains.
    const crossing = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 10, comment: null }],
      }),
    );
    expect(crossing.error).toBeNull();

    const afterCrossing = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, admin.companyId));
    const overbookingRows = afterCrossing.filter((row) => row.templateKey === "stock_overbooking_reached");
    expect(overbookingRows).toHaveLength(1);
    expect(overbookingRows[0]).toMatchObject({ recipientType: "backoffice" });
    expect((overbookingRows[0]!.payload as { productOverbooking: string }).productOverbooking).toBe("5");
  }, 30000);

  it("submit_order enqueues stock_fully_exhausted exactly when demand consumes supply plus its overbooking room — id 11", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    // Supply 10, overbooking 5 — orderable while demand < 15.
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    await db.update(productVarieties).set({ noOverbooking: "5" }).where(eq(productVarieties.id, grower.varietyId));

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    // Demand 0 -> 12: past base supply (also crosses id 10, incidentally —
    // not this test's concern) but still under the overbooking ceiling.
    const stillOrderable = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 12, comment: null }],
      }),
    );
    expect(stillOrderable.error).toBeNull();
    const afterStillOrderable = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, admin.companyId));
    expect(afterStillOrderable.filter((row) => row.templateKey === "stock_fully_exhausted")).toHaveLength(0);

    // Demand 12 -> 15: consumes supply + overbooking exactly.
    //
    // Exactly 15, not 16. Since migration 0042 a direct customer submission
    // is also capped at max_orderable_for_customer() — (supply + overbooking)
    // minus every OTHER customer's demand, so 15 here — and asking for 16
    // is refused with P0008 before any notification logic runs. 15 is also
    // the value this test actually wants: the id 11 threshold is
    // `demand_after >= supply + overbooking`, which 15 meets, so this still
    // exercises the exhaustion edge rather than stepping past it.
    const crossing = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 15, comment: null }],
      }),
    );
    expect(crossing.error).toBeNull();

    const afterCrossing = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.recipientCompanyId, admin.companyId));
    const exhaustedRows = afterCrossing.filter((row) => row.templateKey === "stock_fully_exhausted");
    expect(exhaustedRows).toHaveLength(1);
    expect(exhaustedRows[0]).toMatchObject({ recipientType: "backoffice" });
  }, 30000);

  it("max_orderable_for_customer (migration 0042) tracks the lower of the variety's cap and remaining stock, and submit_order enforces it only on a direct customer submission", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);

    // 10 pallets picked, cap set to 5 — the dropdown ceiling is whichever
    // is lower (the PRD example this mirrors: cap 5 against stock 10 offers
    // 0-5; stock dropping to 3 offers 0-3 even though the cap is still 5).
    const pick = await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    await db
      .update(productVarieties)
      .set({ numberOfOrdersPerCustomer: 5 })
      .where(eq(productVarieties.id, grower.varietyId));

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const withPlentyOfStock = await client.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id }),
    );
    expect(withPlentyOfStock.error).toBeNull();
    expect(withPlentyOfStock.data!.find((row) => row.variety_id === grower.varietyId)).toMatchObject({
      max_orderable_for_customer: 5,
    });

    // Stock drops to 3 (below the cap) — the ceiling follows stock down.
    await db
      .update(dailyPickProducts)
      .set({ palletsPicked: "3" })
      .where(and(eq(dailyPickProducts.dailyPickId, pick.id), eq(dailyPickProducts.productVarietyId, grower.varietyId)));

    const withScarceStock = await client.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id }),
    );
    expect(withScarceStock.error).toBeNull();
    expect(withScarceStock.data!.find((row) => row.variety_id === grower.varietyId)).toMatchObject({
      max_orderable_for_customer: 3,
    });

    // A direct customer submission over that ceiling is rejected...
    const overCap = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 4, comment: null }],
      }),
    );
    expect(overCap.error).not.toBeNull();
    expect(overCap.error?.code).toBe(CUSTOMER_ERROR_CODES.INVALID_INPUT);

    // ...but the identical line succeeds from backoffice acting on the
    // customer's behalf: the cap is a customer-facing UI promise, not a
    // hard ceiling on staff overriding it.
    const backofficeOverride = await admin.client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 4, comment: null }],
        customerCompanyId: customer.companyId,
      }),
    );
    expect(backofficeOverride.error).toBeNull();

    const line = await getOrderProductLine((await getDailyOrderForCustomer(day.id, customer.companyId))!.id, grower.varietyId);
    expect(line).toMatchObject({ palletsOrdered: "4.00" });
  }, 30000);

  it("submit_order (migration 0068): a saved line stays allowed after stock drops below it — re-sending or lowering it is accepted, raising it is refused", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    const pick = await pickLine(day.id, grower.companyId, grower.varietyId, 10);

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const send = (palletsOrdered: number, comment: string | null = null) =>
      client.rpc(
        "submit_order",
        toSubmitOrderRpcArgs({
          tradingDayId: day.id,
          lines: [{ productVarietyId: grower.varietyId, palletsOrdered, comment }],
        }),
      );
    const savedLine = async () =>
      getOrderProductLine((await getDailyOrderForCustomer(day.id, customer.companyId))!.id, grower.varietyId);

    expect((await send(6)).error).toBeNull();

    // The grower lowers the pick to 4 — this customer's limit is now 4, below
    // the 6 they already have.
    await db
      .update(dailyPickProducts)
      .set({ palletsPicked: "4" })
      .where(and(eq(dailyPickProducts.dailyPickId, pick.id), eq(dailyPickProducts.productVarietyId, grower.varietyId)));

    // Sent again with only the comment changed: accepted, the 6 kept.
    expect((await send(6, "שינוי בהערה")).error).toBeNull();
    expect(await savedLine()).toMatchObject({ palletsOrdered: "6.00", comment: "שינוי בהערה" });

    // Lowered, still above the limit: accepted.
    expect((await send(5)).error).toBeNull();
    expect(await savedLine()).toMatchObject({ palletsOrdered: "5.00" });

    // Raised again: refused, and the line stays as it was.
    const raised = await send(6);
    expect(raised.error?.code).toBe(CUSTOMER_ERROR_CODES.INVALID_INPUT);
    expect(await savedLine()).toMatchObject({ palletsOrdered: "5.00" });
  }, 30000);

  it("submit_order (migration 0068): two customers sending at the same moment are checked one after the other, so they can't both take the last pallets", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);

    const customerA = await createTestCustomer(day.id);
    const profileA = await createTestProfile({ companyId: customerA.companyId, role: "customer" });
    cleanupFns.push(() => deleteTestUser(profileA.userId));
    const customerB = await createTestCustomer(day.id);
    const clientB = await signedInCustomer(customerB.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const sevenPallets = [{ productVarietyId: grower.varietyId, palletsOrdered: 7, comment: null }];

    // Customer A's send runs on a connection of its own and is held open,
    // not yet committed, while customer B sends — the moment two real sends
    // share. `.then` starts B's request now rather than when it is awaited.
    // B goes through the API (its own server connections), so it is not held
    // up by this file's one-connection `db` client being inside A's transaction.
    let sendB: PromiseLike<{ error: { code: string } | null }> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('request.jwt.claim.sub', ${profileA.userId}, true)`);
      await tx.execute(sql`set local role authenticated`);
      await tx.execute(
        sql`select public.submit_order(${day.id}::uuid, ${JSON.stringify(sevenPallets)}::jsonb, null)`,
      );
      sendB = clientB
        .rpc("submit_order", toSubmitOrderRpcArgs({ tradingDayId: day.id, lines: sevenPallets }))
        .then((result) => result);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    // B's send waited for A's to commit, then saw it: only 3 were left.
    const resultB = await sendB!;
    expect(resultB.error?.code).toBe(CUSTOMER_ERROR_CODES.INVALID_INPUT);
    const orderA = await getDailyOrderForCustomer(day.id, customerA.companyId);
    const orderB = await getDailyOrderForCustomer(day.id, customerB.companyId);
    expect(await getOrderProductLine(orderA!.id, grower.varietyId)).toMatchObject({ palletsOrdered: "7.00" });
    expect(await getOrderProductLine(orderB!.id, grower.varietyId)).toBeNull();
  }, 30000);

  it("submit_order (migration 0071): once the shop closes a customer can no longer send their own order, but staff can still edit it", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const send = (palletsOrdered: number, customerCompanyId?: string) =>
      (customerCompanyId ? admin.client : client).rpc(
        "submit_order",
        toSubmitOrderRpcArgs({
          tradingDayId: day.id,
          lines: [{ productVarietyId: grower.varietyId, palletsOrdered, comment: null }],
          ...(customerCompanyId ? { customerCompanyId } : {}),
        }),
      );
    const savedLine = async () =>
      getOrderProductLine((await getDailyOrderForCustomer(day.id, customer.companyId))!.id, grower.varietyId);

    expect((await send(2)).error).toBeNull();
    expect((await admin.client.rpc("close_shop")).error).toBeNull();

    // The shop is closed: the customer's own change is refused and nothing moves.
    const refused = await send(3);
    expect(refused.error?.code).toBe(CUSTOMER_ERROR_CODES.INVALID_STATE);
    expect(await savedLine()).toMatchObject({ palletsOrdered: "2.00" });

    // The distributor, arranging, may still adjust it on the customer's behalf.
    expect((await send(4, customer.companyId)).error).toBeNull();
    expect(await savedLine()).toMatchObject({ palletsOrdered: "4.00" });
  }, 30000);

  // The padded comment goes straight to the database (no zod in between), so
  // the trimming checked here is submit_order's own.
  it("submit_order (migration 0093): stores the order comment trimmed, keeps it when left out, clears it with an empty string, and refuses a customer's own change once the shop has closed", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const send = (comment?: string) =>
      client.rpc(
        "submit_order",
        toSubmitOrderRpcArgs({
          tradingDayId: day.id,
          lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 2, comment: null }],
          ...(comment === undefined ? {} : { comment }),
        }),
      );
    const storedComment = async () => (await getDailyOrderForCustomer(day.id, customer.companyId))!.comment;

    expect((await send("  להביא לפני 6 ")).error).toBeNull();
    expect(await storedComment()).toBe("להביא לפני 6");
    expect((await send()).error).toBeNull();
    expect(await storedComment()).toBe("להביא לפני 6");
    expect((await send("")).error).toBeNull();
    expect(await storedComment()).toBeNull();

    expect((await send("לפני הסגירה")).error).toBeNull();
    expect((await admin.client.rpc("close_shop")).error).toBeNull();
    const refused = await send("אחרי הסגירה");
    expect(refused.error?.code).toBe(CUSTOMER_ERROR_CODES.INVALID_STATE);
    expect(await storedComment()).toBe("לפני הסגירה");
  }, 30000);

  it("get_orderable_catalog_for_customer (migration 0094): returns the variety's own picture as variety_image_url, null when it has none", async () => {
    const withPicture = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(withPicture));
    const withoutPicture = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(withoutPicture));
    await db
      .update(productVarieties)
      .set({ imageUrl: "https://example.test/varieties/a.jpg" })
      .where(eq(productVarieties.id, withPicture.varietyId));

    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, withPicture.companyId, withPicture.varietyId, 5);
    await pickLine(day.id, withoutPicture.companyId, withoutPicture.varietyId, 5);
    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const { data, error } = await client.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: day.id }),
    );
    expect(error).toBeNull();
    // undefined (not listed at all) fails both: the rows must be there.
    const pictureOf = (varietyId: string) => data!.find((row) => row.variety_id === varietyId)?.variety_image_url;
    expect(pictureOf(withPicture.varietyId)).toBe("https://example.test/varieties/a.jpg");
    expect(pictureOf(withoutPicture.varietyId)).toBeNull();
  }, 30000);

  it("get_orderable_catalog_for_customer (migration 0072): a customer sees prices only when both the day's shop and their company allow it, and never through an older day's id", async () => {
    const grower = await createTestGrowerWithProduct({ price: 9.9 });
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);
    // A closed earlier day whose shop showed prices, with the same product.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const earlier = await createTestTradingDay({ initiatedByUserId: admin.userId, phase: "closed", tradeDate: yesterday });
    await createTestDailyShop({ tradingDayId: earlier.id, openedByUserId: admin.userId, canSeePrices: true });
    await pickLine(earlier.id, grower.companyId, grower.varietyId, 10);

    const customer = await createTestCustomer(day.id);
    const client = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(earlier.id));
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const setFlags = async (dayShowsPrices: boolean, companyMaySee: boolean | null) => {
      await db.update(dailyShops).set({ canSeePrices: dayShowsPrices }).where(eq(dailyShops.tradingDayId, day.id));
      await db.update(companies).set({ canSeeProductPrices: companyMaySee }).where(eq(companies.id, customer.companyId));
    };
    const priceSeen = async (viewer: SupabaseClient<Database>, tradingDayId: string, customerCompanyId?: string) => {
      const { data, error } = await viewer.rpc(
        "get_orderable_catalog_for_customer",
        toOrderableCatalogRpcArgs({ tradingDayId, ...(customerCompanyId ? { customerCompanyId } : {}) }),
      );
      expect(error).toBeNull();
      const row = data!.find((r) => r.variety_id === grower.varietyId);
      expect(row).toBeDefined();
      return row!.price;
    };

    // Bubble's rule: both switches on, or no price.
    for (const [dayShowsPrices, companyMaySee] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      await setFlags(dayShowsPrices, companyMaySee);
      expect(await priceSeen(client, day.id)).toBe(dayShowsPrices && companyMaySee ? 9.9 : null);
    }
    // A permission never set counts as "may not".
    await setFlags(true, null);
    expect(await priceSeen(client, day.id)).toBeNull();

    // Today hides prices; the earlier day showed them. The prices returned
    // are today's, so asking for the earlier day must not reveal them.
    await setFlags(false, true);
    expect(await priceSeen(client, earlier.id)).toBeNull();

    // Staff are unchanged: the day's switch alone decides what they see.
    await setFlags(true, false);
    expect(await priceSeen(admin.client, day.id, customer.companyId)).toBe(9.9);
  }, 30000);

  it("get_orderable_catalog_for_customer and submit_order (migration 0072): a customer's blocked product is hidden from them and untouched by their saves; a colleague and staff are unaffected", async () => {
    const open = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(open));
    const blocked = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(blocked));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, open.companyId, open.varietyId, 10);
    await pickLine(day.id, blocked.companyId, blocked.varietyId, 10);

    const customer = await createTestCustomer(day.id);
    const blockedUser = await createTestProfile({ companyId: customer.companyId, role: "customer" });
    cleanupFns.push(() => deleteTestUser(blockedUser.userId));
    const blockedClient = await signInTestUser(blockedUser.email, blockedUser.password);
    const colleague = await signedInCustomer(customer.companyId);
    cleanupFns.push(() => deleteTestTradingDay(day.id));
    await db.insert(profileBlockedProducts).values({ userId: blockedUser.userId, productVarietyId: blocked.varietyId });

    const listed = async (viewer: SupabaseClient<Database>, customerCompanyId?: string) => {
      const { data, error } = await viewer.rpc(
        "get_orderable_catalog_for_customer",
        toOrderableCatalogRpcArgs({ tradingDayId: day.id, ...(customerCompanyId ? { customerCompanyId } : {}) }),
      );
      expect(error).toBeNull();
      return data!.map((r) => r.variety_id);
    };
    const send = (viewer: SupabaseClient<Database>, lines: Array<[string, number]>, customerCompanyId?: string) =>
      viewer.rpc(
        "submit_order",
        toSubmitOrderRpcArgs({
          tradingDayId: day.id,
          lines: lines.map(([productVarietyId, palletsOrdered]) => ({ productVarietyId, palletsOrdered, comment: null })),
          ...(customerCompanyId ? { customerCompanyId } : {}),
        }),
      );
    const saved = async (varietyId: string) =>
      (await getOrderProductLine((await getDailyOrderForCustomer(day.id, customer.companyId))!.id, varietyId))?.palletsOrdered ?? null;

    // The colleague orders both products for the company.
    expect((await send(colleague, [[open.varietyId, 1], [blocked.varietyId, 3]])).error).toBeNull();

    // The blocked customer is not shown the blocked product, though it is in
    // the company's order; the colleague and staff still see it.
    expect(await listed(blockedClient)).toEqual([open.varietyId]);
    expect(await listed(colleague)).toEqual(expect.arrayContaining([open.varietyId, blocked.varietyId]));
    expect(await listed(admin.client, customer.companyId)).toEqual(expect.arrayContaining([open.varietyId, blocked.varietyId]));

    // Their save sends what they see — and leaves the colleague's line alone.
    expect((await send(blockedClient, [[open.varietyId, 2]])).error).toBeNull();
    expect(await saved(open.varietyId)).toBe("2.00");
    expect(await saved(blocked.varietyId)).toBe("3.00");

    // Ordering the blocked product straight through the API is ignored.
    expect((await send(blockedClient, [[open.varietyId, 2], [blocked.varietyId, 5]])).error).toBeNull();
    expect(await saved(blocked.varietyId)).toBe("3.00");

    // Staff are unaffected: leaving the line out of their save removes it.
    expect((await send(admin.client, [[open.varietyId, 2]], customer.companyId)).error).toBeNull();
    expect(await saved(blocked.varietyId)).toBeNull();
  }, 30000);

  it("save_customer (migration 0080): a customer added — or made active again — after the shop opens can order that day and gets one 'shop is open' message", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const day = await createOpenTestDay(admin.userId);
    await pickLine(day.id, grower.companyId, grower.varietyId, 10);

    const save = (id: string | null, status: "active" | "inactive") =>
      admin.client.rpc(
        "save_customer",
        toSaveCustomerRpcArgs({
          id,
          name: `לקוח אמצע היום ${randomUUID()}`,
          status,
          canSeeProductPrices: true,
          whatsappGroupId: null,
          contactPersonId: null,
        }),
      );
    const shopOpenMessages = async (companyId: string) =>
      (
        await db
          .select({ id: notificationOutbox.id })
          .from(notificationOutbox)
          .where(and(eq(notificationOutbox.recipientCompanyId, companyId), eq(notificationOutbox.templateKey, "shop_open")))
      ).length;

    // Added mid-day, and a second one added inactive.
    const added = await save(null, "active");
    expect(added.error).toBeNull();
    const addedId = added.data!.id;
    cleanupFns.push(() => deleteTestCompany(addedId));
    const later = await save(null, "inactive");
    expect(later.error).toBeNull();
    const laterId = later.data!.id;
    cleanupFns.push(() => deleteTestCompany(laterId));
    const client = await signedInCustomer(addedId);
    // Last, so it runs first: the day goes before the companies it holds orders for.
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    expect(await getDailyOrderForCustomer(day.id, addedId)).toBeTruthy();
    expect(await shopOpenMessages(addedId)).toBe(1);
    const sent = await client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: day.id,
        lines: [{ productVarietyId: grower.varietyId, palletsOrdered: 2, comment: null }],
      }),
    );
    expect(sent.error).toBeNull();

    // Saving again sends nothing new; an inactive customer gets nothing until made active.
    expect((await save(addedId, "active")).error).toBeNull();
    expect(await shopOpenMessages(addedId)).toBe(1);
    expect(await getDailyOrderForCustomer(day.id, laterId)).toBeFalsy();
    expect((await save(laterId, "active")).error).toBeNull();
    expect(await getDailyOrderForCustomer(day.id, laterId)).toBeTruthy();
    expect(await shopOpenMessages(laterId)).toBe(1);
  }, 30000);

  // The price each order line records when it is saved (James, 2026-11-12):
  // for a customer who may see prices — their company's permission AND the
  // day's shop showing prices, the same test the shop uses to show one — by
  // the product's price type, on every save. Kept for the record; no screen
  // shows it. Written for CI; checked where it was written against a local
  // PGlite copy of every migration instead (no local Supabase there).
  describe("submit_order's price record (migration 0101)", () => {
    const NOTHING = { priceType: null, price: null, priceRangeFrom: null, priceRangeTo: null };

    // A product picked today whose stored numbers include ones its type
    // hides, so the record has to choose by type.
    async function pricedProduct(
      tradingDayId: string,
      prices: Partial<typeof productVarieties.$inferInsert>,
    ) {
      const grower = await createTestGrowerWithProduct();
      cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
      await db
        .update(productVarieties)
        .set(prices)
        .where(eq(productVarieties.id, grower.varietyId));
      await pickLine(tradingDayId, grower.companyId, grower.varietyId, 10);
      return grower.varietyId;
    }

    async function customerWithPermission(tradingDayId: string, maySeePrices: boolean | null) {
      const customer = await createTestCustomer(tradingDayId);
      await db
        .update(companies)
        .set({ canSeeProductPrices: maySeePrices })
        .where(eq(companies.id, customer.companyId));
      return customer;
    }

    async function savedLine(tradingDayId: string, customerCompanyId: string, varietyId: string) {
      const order = await getDailyOrderForCustomer(tradingDayId, customerCompanyId);
      const line = await getOrderProductLine(order!.id, varietyId);
      expect(line).toBeTruthy();
      return {
        pallets: line!.palletsOrdered,
        record: {
          priceType: line!.priceType,
          price: line!.price,
          priceRangeFrom: line!.priceRangeFrom,
          priceRangeTo: line!.priceRangeTo,
        },
      };
    }

    it("records מספר as its price, טווח as its range and a תקליט type as the type alone — again on every save, untouched lines too", async () => {
      const day = await createOpenTestDay(admin.userId);
      const fixed = await pricedProduct(day.id, {
        priceType: "fixed",
        price: "12.5",
        priceRangeFrom: "9",
        priceRangeTo: "11",
      });
      const range = await pricedProduct(day.id, {
        priceType: "range",
        price: "7",
        priceRangeFrom: "10",
        priceRangeTo: "12",
      });
      const record = await pricedProduct(day.id, { priceType: "record_plus_1", price: "5" });
      const customer = await customerWithPermission(day.id, true);
      const client = await signedInCustomer(customer.companyId);
      cleanupFns.push(() => deleteTestTradingDay(day.id));

      const sendAll = () =>
        client.rpc(
          "submit_order",
          toSubmitOrderRpcArgs({
            tradingDayId: day.id,
            lines: [fixed, range, record].map((productVarietyId) => ({
              productVarietyId,
              palletsOrdered: 1,
              comment: null,
            })),
          }),
        );

      expect((await sendAll()).error).toBeNull();
      expect((await savedLine(day.id, customer.companyId, fixed)).record).toEqual({
        ...NOTHING,
        priceType: "fixed",
        price: "12.50",
      });
      expect((await savedLine(day.id, customer.companyId, range)).record).toEqual({
        ...NOTHING,
        priceType: "range",
        priceRangeFrom: "10.00",
        priceRangeTo: "12.00",
      });
      expect((await savedLine(day.id, customer.companyId, record)).record).toEqual({
        ...NOTHING,
        priceType: "record_plus_1",
      });

      // The office changes the prices, and the customer sends the same order
      // again without touching a line: every line records today's price.
      await db.update(productVarieties).set({ price: "14" }).where(eq(productVarieties.id, fixed));
      await db
        .update(productVarieties)
        .set({ priceType: "record_minus_1" })
        .where(eq(productVarieties.id, record));
      expect((await sendAll()).error).toBeNull();
      expect((await savedLine(day.id, customer.companyId, fixed)).record).toEqual({
        ...NOTHING,
        priceType: "fixed",
        price: "14.00",
      });
      expect((await savedLine(day.id, customer.companyId, record)).record).toEqual({
        ...NOTHING,
        priceType: "record_minus_1",
      });
    }, 45000);

    it("records only when the customer may see prices — on staff's saves too, by the customer's own permission — and otherwise leaves a line's record as it was", async () => {
      const day = await createOpenTestDay(admin.userId);
      const fixed = await pricedProduct(day.id, { priceType: "fixed", price: "12.5" });
      const maySee = await customerWithPermission(day.id, true);
      const mayNot = await customerWithPermission(day.id, false);
      const neverSet = await customerWithPermission(day.id, null);
      const maySeeClient = await signedInCustomer(maySee.companyId);
      const mayNotClient = await signedInCustomer(mayNot.companyId);
      const neverSetClient = await signedInCustomer(neverSet.companyId);
      cleanupFns.push(() => deleteTestTradingDay(day.id));

      const send = (
        viewer: SupabaseClient<Database>,
        palletsOrdered: number,
        customerCompanyId?: string,
      ) =>
        viewer.rpc(
          "submit_order",
          toSubmitOrderRpcArgs({
            tradingDayId: day.id,
            lines: [{ productVarietyId: fixed, palletsOrdered, comment: null }],
            ...(customerCompanyId ? { customerCompanyId } : {}),
          }),
        );
      const recordOf = async (customerCompanyId: string) =>
        (await savedLine(day.id, customerCompanyId, fixed)).record;

      // Their own saves: only the company with the permission records it. A
      // permission never set counts as "may not", as in the shop.
      expect((await send(maySeeClient, 1)).error).toBeNull();
      expect((await send(mayNotClient, 1)).error).toBeNull();
      expect((await send(neverSetClient, 1)).error).toBeNull();
      expect(await recordOf(maySee.companyId)).toEqual({
        ...NOTHING,
        priceType: "fixed",
        price: "12.50",
      });
      expect(await recordOf(mayNot.companyId)).toEqual(NOTHING);
      expect(await recordOf(neverSet.companyId)).toEqual(NOTHING);

      // Staff saving on a customer's behalf see the price on either screen,
      // but what the line records follows the customer's own permission.
      await db.update(productVarieties).set({ price: "13" }).where(eq(productVarieties.id, fixed));
      expect((await send(admin.client, 2, maySee.companyId)).error).toBeNull();
      expect((await send(admin.client, 2, mayNot.companyId)).error).toBeNull();
      expect(await recordOf(maySee.companyId)).toEqual({
        ...NOTHING,
        priceType: "fixed",
        price: "13.00",
      });
      expect(await recordOf(mayNot.companyId)).toEqual(NOTHING);

      // On a day the shop hides prices, a save records nothing new and
      // clears nothing: the quantity changes, the record stays.
      await db
        .update(dailyShops)
        .set({ canSeePrices: false })
        .where(eq(dailyShops.tradingDayId, day.id));
      await db.update(productVarieties).set({ price: "14" }).where(eq(productVarieties.id, fixed));
      expect((await send(maySeeClient, 3)).error).toBeNull();
      expect(await savedLine(day.id, maySee.companyId, fixed)).toEqual({
        pallets: "3.00",
        record: { ...NOTHING, priceType: "fixed", price: "13.00" },
      });
    }, 45000);
  });

  // Workbook Task 36: the growers behind the order screen's "מגדל מועדף"
  // button. Written for CI; not run where they were written (no local
  // database there).
  describe("get_variety_growers_for_customer (migration 0095)", () => {
    // A grower company with nothing else — the extra growers of a variety
    // that createTestGrowerWithProduct's own grower already has.
    async function createTestGrower(status: "active" | "inactive" = "active") {
      const company = await createTestCompany(`מגדל בדיקה ${randomUUID()}`, "grower");
      cleanupFns.push(() => deleteTestCompany(company.id));
      if (status === "inactive") {
        await db.update(companies).set({ status }).where(eq(companies.id, company.id));
      }
      return company;
    }

    // One grower's line for a variety on the day: what was picked and what was
    // carried in. Adds to that grower's pick for the day if it already has
    // one (there is one per grower and day).
    async function stockLine(
      tradingDayId: string,
      growerCompanyId: string,
      productVarietyId: string,
      picked: number,
      leftover = 0,
    ) {
      const pick =
        (await getDailyPickForGrower(tradingDayId, growerCompanyId)) ??
        (await db.insert(dailyPicks).values({ tradingDayId, growerCompanyId }).returning())[0];
      if (!pick) throw new Error("failed to create test daily pick");
      await db.insert(dailyPickProducts).values({
        dailyPickId: pick.id,
        productVarietyId,
        palletsPicked: picked.toString(),
        leftoverPallets: leftover.toString(),
      });
    }

    const growersFor = (
      viewer: SupabaseClient<Database>,
      tradingDayId: string,
      customerCompanyId?: string,
    ) =>
      viewer.rpc(
        "get_variety_growers_for_customer",
        // The catalog's own two arguments (see the function's comment).
        toOrderableCatalogRpcArgs({
          tradingDayId,
          ...(customerCompanyId ? { customerCompanyId } : {}),
        }),
      );

    it("names every grower with the variety in stock — picked, or only carried in — and only where two or more do", async () => {
      // Grower A's variety, which B, C and D also have lines for, and a
      // second variety only A has in stock.
      const grower = await createTestGrowerWithProduct();
      cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
      const onlyA = await createTestProductVariety({ familyId: grower.familyId });
      cleanupFns.push(() => deleteTestProductVariety(onlyA.id));
      const leftoverOnly = await createTestGrower();
      const nothingOn = await createTestGrower();
      const inactive = await createTestGrower("inactive");

      const day = await createOpenTestDay(admin.userId);
      await stockLine(day.id, grower.companyId, grower.varietyId, 5);
      await stockLine(day.id, grower.companyId, onlyA.id, 3);
      // Nothing picked today, but 2 carried in from the day before: in stock.
      await stockLine(day.id, leftoverOnly.id, grower.varietyId, 0, 2);
      // A line with nothing on it, of both varieties: not in stock.
      await stockLine(day.id, nothingOn.id, grower.varietyId, 0, 0);
      await stockLine(day.id, nothingOn.id, onlyA.id, 0, 0);
      // Stock, but the grower is inactive.
      await stockLine(day.id, inactive.id, grower.varietyId, 4);

      const customer = await createTestCustomer(day.id);
      const client = await signedInCustomer(customer.companyId);
      cleanupFns.push(() => deleteTestTradingDay(day.id));

      const { data, error } = await growersFor(client, day.id);
      expect(error).toBeNull();
      const rows = data ?? [];
      // Names only, nothing else about the growers.
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(["grower_name", "variety_id"]);
      }
      // A and the leftover-only grower, for A's variety; nobody for the
      // variety only A has in stock — one grower is no choice.
      expect(rows.map((row) => row.variety_id)).toEqual([grower.varietyId, grower.varietyId]);
      expect(rows.map((row) => row.grower_name).sort()).toEqual(
        [grower.companyName, leftoverOnly.name].sort(),
      );
    }, 45000);

    it("names no grower of a product on the customer user's own blocked list; a colleague and staff are unaffected", async () => {
      const grower = await createTestGrowerWithProduct();
      cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
      const second = await createTestGrower();
      const day = await createOpenTestDay(admin.userId);
      await stockLine(day.id, grower.companyId, grower.varietyId, 5);
      await stockLine(day.id, second.id, grower.varietyId, 3);

      const customer = await createTestCustomer(day.id);
      const blockedUser = await createTestProfile({ companyId: customer.companyId, role: "customer" });
      cleanupFns.push(() => deleteTestUser(blockedUser.userId));
      const blockedClient = await signInTestUser(blockedUser.email, blockedUser.password);
      const colleague = await signedInCustomer(customer.companyId);
      cleanupFns.push(() => deleteTestTradingDay(day.id));
      await db
        .insert(profileBlockedProducts)
        .values({ userId: blockedUser.userId, productVarietyId: grower.varietyId });

      const blocked = await growersFor(blockedClient, day.id);
      expect(blocked.error).toBeNull();
      expect(blocked.data).toEqual([]);

      const names = [grower.companyName, second.name].sort();
      const ofColleague = await growersFor(colleague, day.id);
      expect(ofColleague.error).toBeNull();
      expect((ofColleague.data ?? []).map((row) => row.grower_name).sort()).toEqual(names);
      const ofStaff = await growersFor(admin.client, day.id, customer.companyId);
      expect(ofStaff.error).toBeNull();
      expect((ofStaff.data ?? []).map((row) => row.grower_name).sort()).toEqual(names);
    }, 45000);

    it("lets backoffice name a customer, and refuses a customer naming any company, a grower, and a caller who is not signed in", async () => {
      const grower = await createTestGrowerWithProduct();
      cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
      const second = await createTestGrower();
      const day = await createOpenTestDay(admin.userId);
      await stockLine(day.id, grower.companyId, grower.varietyId, 5);
      await stockLine(day.id, second.id, grower.varietyId, 3);

      const customer = await createTestCustomer(day.id);
      const other = await createTestCustomer(day.id);
      const client = await signedInCustomer(customer.companyId);
      const growerUser = await createTestProfile({ companyId: grower.companyId, role: "grower" });
      cleanupFns.push(() => deleteTestUser(growerUser.userId));
      const growerClient = await signInTestUser(growerUser.email, growerUser.password);
      cleanupFns.push(() => deleteTestTradingDay(day.id));

      // Staff, on the customer's behalf.
      const ofStaff = await growersFor(admin.client, day.id, customer.companyId);
      expect(ofStaff.error).toBeNull();
      expect((ofStaff.data ?? []).map((row) => row.grower_name).sort()).toEqual(
        [grower.companyName, second.name].sort(),
      );

      // A customer naming a company — another one, or even their own — as
      // with the catalog.
      for (const named of [other.companyId, customer.companyId]) {
        const refused = await growersFor(client, day.id, named);
        expect(refused.error?.code).toBe(CUSTOMER_ERROR_CODES.FORBIDDEN);
        expect(refused.data).toBeNull();
      }

      // A grower, who may read the catalog (0076) but not this: it would name
      // the other growers that have the product today.
      const ofGrower = await growersFor(growerClient, day.id);
      expect(ofGrower.error?.code).toBe(CUSTOMER_ERROR_CODES.FORBIDDEN);

      // Not signed in: turned away before the function runs at all.
      const anonymous = await growersFor(createAnonClient(), day.id);
      expect(anonymous.error?.code).toBe(CUSTOMER_ERROR_CODES.FORBIDDEN);
      expect(anonymous.error?.message).toMatch(/permission denied/);
    }, 45000);

    it("answers a customer only while that day's shop is open — not once it closes, nor for a closed day — and staff on any day", async () => {
      const grower = await createTestGrowerWithProduct();
      cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
      const second = await createTestGrower();
      const day = await createOpenTestDay(admin.userId);
      await stockLine(day.id, grower.companyId, grower.varietyId, 5);
      await stockLine(day.id, second.id, grower.varietyId, 3);

      const customer = await createTestCustomer(day.id);
      const client = await signedInCustomer(customer.companyId);
      cleanupFns.push(() => deleteTestTradingDay(day.id));

      const names = [grower.companyName, second.name].sort();
      const namesFor = async (viewer: SupabaseClient<Database>, customerCompanyId?: string) => {
        const { data, error } = await growersFor(viewer, day.id, customerCompanyId);
        expect(error).toBeNull();
        return (data ?? []).map((row) => row.grower_name).sort();
      };

      // Open: the customer's order can change, so there is a choice to offer.
      expect(await namesFor(client)).toEqual(names);

      // The shop has closed: their order can no longer change, so no names —
      // and no error, for a screen still open at that moment. Staff, who may
      // still change the order, are unaffected.
      expect((await admin.client.rpc("close_shop")).error).toBeNull();
      expect(await namesFor(client)).toEqual([]);
      expect(await namesFor(admin.client, customer.companyId)).toEqual(names);

      // A closed day, as every earlier one is: nothing for the customer
      // either, so the history of who had what cannot be read back.
      expect(
        (await admin.client.from("trading_days").update({ phase: "closed" }).eq("id", day.id)).error,
      ).toBeNull();
      expect(await namesFor(client)).toEqual([]);
      expect(await namesFor(admin.client, customer.companyId)).toEqual(names);
    }, 45000);
  });
});
