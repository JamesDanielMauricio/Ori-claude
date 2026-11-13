import { db } from "@ori/db";
import {
  alerts,
  arrangementRecords,
  companies,
  dailyArrangements,
  dailyOrderProducts,
  dailyOrders,
  dailyPickProducts,
  dailyPicks,
  growerProducts,
  notificationOutbox,
  productVarieties,
  tradingDays,
} from "@ori/db/schema";
import type { Database, Json } from "@ori/db/supabase-types";
import { createServiceRoleClient } from "@ori/domain/auth";
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
  toInitiateBusinessDayRpcArgs,
  toUpdatePickProductPalletsRpcArgs,
} from "@ori/domain/lifecycle-engine";
import {
  createTestGrowerWithProduct,
  createTestOrderProductLine,
  createTestTradingDay,
  deleteTestGrowerWithProduct,
  deleteTestTradingDay,
  getDailyPickForGrower,
  getPickProductLine,
  type TestGrowerWithProduct,
} from "@ori/domain/lifecycle-engine/testing";
import { PRICE_TYPES } from "@ori/shared/price-type";
import type { SupabaseClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ARRANGEMENT_ERROR_CODES,
  type SaveArrangementChangesInput,
  toCreateArrangementRecordRpcArgs,
  toDeleteArrangementRecordRpcArgs,
  toSaveArrangementChangesRpcArgs,
  toSaveArrangementProposalRpcArgs,
  toUpdateArrangementRecordRpcArgs,
} from "./schemas";

// Like customer.test.ts, every fixture trading day here is created via the
// real initiate_business_day RPC (single-open-trading-day partial unique
// index, 0009) — sequential execution across the whole domain package
// (vitest.config.ts's fileParallelism: false) is what keeps this file's
// days from colliding with lifecycle.test.ts's or customer.test.ts's.
describe("arrangement module", () => {
  const cleanupFns: Array<() => Promise<void>> = [];
  const adminCleanupFns: Array<() => Promise<void>> = [];
  let admin: { client: SupabaseClient<Database>; userId: string };

  // One shared backoffice admin for the whole file — every function this
  // module tests is backoffice-only, so there's nothing an identity-per-test
  // would protect here (same reasoning as customer.test.ts).
  beforeAll(async () => {
    const company = await createTestCompany();
    adminCleanupFns.push(() => deleteTestCompany(company.id));
    const profile = await createTestProfile({ companyId: company.id, role: "backoffice" });
    adminCleanupFns.push(() => deleteTestUser(profile.userId));
    admin = {
      client: await signInTestUser(profile.email, profile.password),
      userId: profile.userId,
    };
  });

  afterAll(async () => {
    await runCleanup(adminCleanupFns);
  });

  afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  // Sets up a trading day (via the real RPC, so the bootstrap pick/
  // arrangement rows exist) with one grower pick line and one customer
  // order line for the same variety, and returns everything a test needs
  // to pair them via create_arrangement_record.
  async function setUpDayWithSupplyAndDemand(palletsPicked: number, palletsOrdered: number) {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const customer = await createTestCompany(`לקוח בדיקה ${crypto.randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(customer.id));

    const tradeDate = new Date().toISOString().slice(0, 10);
    const initiate = await admin.client.rpc(
      "initiate_business_day",
      toInitiateBusinessDayRpcArgs({ tradeDate }),
    );
    expect(initiate.error).toBeNull();
    const day = initiate.data!;
    // Pushed before the grower/customer companies (LIFO: this runs first),
    // matching lifecycle-engine/test-helpers.ts's cascade-ordering note —
    // deleting the day cascades away the pick/order lines and arrangement
    // records this test creates, before their owning companies are torn
    // down.
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    // Opened before the order line is created below: open_shop bootstraps
    // a daily_orders header for every active customer, with no
    // ON CONFLICT DO NOTHING — creating the order line first would leave
    // open_shop to collide with it on daily_orders' own
    // (trading_day_id, customer_company_id) unique constraint.
    const openShop = await admin.client.rpc("open_shop", { p_can_see_prices: true });
    expect(openShop.error).toBeNull();

    const pick = await getDailyPickForGrower(day.id, grower.companyId);
    const pickLine = await getPickProductLine(pick!.id, grower.varietyId);
    const updatePallets = await admin.client.rpc(
      "update_pick_product_pallets",
      toUpdatePickProductPalletsRpcArgs({ dailyPickProductId: pickLine!.id, palletsPicked }),
    );
    expect(updatePallets.error).toBeNull();

    const orderLine = await createTestOrderProductLine(
      day.id,
      customer.id,
      grower.varietyId,
      palletsOrdered,
    );

    return { day, grower, customer, pickProductId: pickLine!.id, orderProductId: orderLine.id };
  }

  it("create_arrangement_record blocks over-allocation against the pick line's own pallets_picked ceiling", async () => {
    const { pickProductId, orderProductId } = await setUpDayWithSupplyAndDemand(5, 10);

    const overSupply = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 6,
      }),
    );
    expect(overSupply.error).not.toBeNull();
    expect(overSupply.error?.code).toBe(ARRANGEMENT_ERROR_CODES.OVER_ALLOCATION);

    const atCeiling = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 5,
      }),
    );
    expect(atCeiling.error).toBeNull();
    expect(atCeiling.data).toMatchObject({
      daily_pick_product_id: pickProductId,
      daily_order_product_id: orderProductId,
    });
  }, 30000);

  it("create_arrangement_record blocks over-allocation against the order line's own pallets_ordered ceiling", async () => {
    const { pickProductId, orderProductId } = await setUpDayWithSupplyAndDemand(10, 4);

    const overDemand = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 6,
      }),
    );
    expect(overDemand.error).not.toBeNull();
    expect(overDemand.error?.code).toBe(ARRANGEMENT_ERROR_CODES.OVER_ALLOCATION);

    const atCeiling = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 4,
      }),
    );
    expect(atCeiling.error).toBeNull();
  }, 30000);

  it("create_arrangement_record rejects a genuinely concurrent double-call that would jointly over-allocate the same pick line — two real rpc() calls racing via Promise.all", async () => {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const customerA = await createTestCompany(`לקוח בדיקה ${crypto.randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(customerA.id));
    const customerB = await createTestCompany(`לקוח בדיקה ${crypto.randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(customerB.id));

    const tradeDate = new Date().toISOString().slice(0, 10);
    const initiate = await admin.client.rpc(
      "initiate_business_day",
      toInitiateBusinessDayRpcArgs({ tradeDate }),
    );
    expect(initiate.error).toBeNull();
    const day = initiate.data!;
    cleanupFns.push(() => deleteTestTradingDay(day.id));

    const openShop = await admin.client.rpc("open_shop", { p_can_see_prices: true });
    expect(openShop.error).toBeNull();

    // 10 pallets picked — each of the two racing calls (6 pallets) is
    // within that ceiling alone, but the two together (12) are not.
    const pick = await getDailyPickForGrower(day.id, grower.companyId);
    const pickLine = await getPickProductLine(pick!.id, grower.varietyId);
    const updatePallets = await admin.client.rpc(
      "update_pick_product_pallets",
      toUpdatePickProductPalletsRpcArgs({ dailyPickProductId: pickLine!.id, palletsPicked: 10 }),
    );
    expect(updatePallets.error).toBeNull();

    // Two different order lines (10 pallets ordered each) so demand is
    // never the limiting side of this race — only the shared pick line's
    // supply ceiling is being contended for.
    const orderLineA = await createTestOrderProductLine(day.id, customerA.id, grower.varietyId, 10);
    const orderLineB = await createTestOrderProductLine(day.id, customerB.id, grower.varietyId, 10);

    const [first, second] = await Promise.all([
      admin.client.rpc(
        "create_arrangement_record",
        toCreateArrangementRecordRpcArgs({
          dailyPickProductId: pickLine!.id,
          dailyOrderProductId: orderLineA.id,
          quantityPallets: 6,
        }),
      ),
      admin.client.rpc(
        "create_arrangement_record",
        toCreateArrangementRecordRpcArgs({
          dailyPickProductId: pickLine!.id,
          dailyOrderProductId: orderLineB.id,
          quantityPallets: 6,
        }),
      ),
    ]);

    // create_arrangement_record locks the trading day's daily_arrangements
    // row (`select ... for update`) before it ever sums existing
    // arrangement_records — the same serialization mechanism
    // close_arrangement's own concurrency test relies on. The loser's
    // check_arrangement_allocation call only runs after the winner's
    // insert has committed, so it sees the winner's 6 pallets already
    // counted against the pick line's 10-pallet ceiling and correctly
    // rejects its own 6 (6 + 6 > 10) — this is real serialization
    // catching a real race, not a lucky ordering of two independent calls.
    const results = [first, second];
    const succeeded = results.filter((r) => r.error === null);
    const failed = results.filter((r) => r.error !== null);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error?.code).toBe(ARRANGEMENT_ERROR_CODES.OVER_ALLOCATION);

    const { data: recordsAfter } = await admin.client
      .from("arrangement_records")
      .select("quantity_pallets")
      .eq("daily_pick_product_id", pickLine!.id);
    expect(recordsAfter).toHaveLength(1);
  }, 30000);

  // save_arrangement_proposal (0068): the whole proposal in one transaction,
  // only into empty cells. Each cell goes through arrange_to_customer.
  async function recordsOn(pickProductId: string) {
    const { data, error } = await admin.client
      .from("arrangement_records")
      .select("id, quantity_pallets, customer_company_id, created_at")
      .eq("daily_pick_product_id", pickProductId);
    expect(error).toBeNull();
    return data ?? [];
  }

  // A customer who orders nothing on the day. Created BEFORE the day, so that
  // open_shop gives them the order header arrange_to_customer needs — and so
  // that, cleanup running last-in-first-out, the day (and its orders) goes
  // before they do.
  async function customerWhoOrdersNothing() {
    const company = await createTestCompany(`לקוח בדיקה ${crypto.randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(company.id));
    return company;
  }

  // The call as a browser would send it, for input the typed helper would not
  // let through.
  function saveRaw(tradingDayId: string, allocations: Json) {
    return admin.client.rpc("save_arrangement_proposal", {
      p_trading_day_id: tradingDayId,
      p_allocations: allocations,
    });
  }

  // save_arrangement_changes (0103): "שמור שינויים" on the products grid. Each
  // change says what its cell held when it was changed; EMPTY is a cell that
  // held nothing.
  const EMPTY = { recordId: null, quantityPallets: 0 };
  function saveChanges(tradingDayId: string, changes: SaveArrangementChangesInput["changes"]) {
    return admin.client.rpc(
      "save_arrangement_changes",
      toSaveArrangementChangesRpcArgs({ tradingDayId, changes }),
    );
  }

  // As saveRaw: the call as a browser would send it.
  function saveChangesRaw(tradingDayId: string, changes: Json) {
    return admin.client.rpc("save_arrangement_changes", {
      p_trading_day_id: tradingDayId,
      p_changes: changes,
    });
  }

  // A cell saved the way the board's ✓ saves one: what the screen read before
  // its changes were made, or what another distributor saved meanwhile.
  async function arrangeNow(pickProductId: string, customerId: string, quantity: number) {
    const { data, error } = await admin.client.rpc("arrange_to_customer", {
      p_daily_pick_product_id: pickProductId,
      p_customer_company_id: customerId,
      p_quantity_pallets: quantity,
    });
    expect(error).toBeNull();
    return data!;
  }

  // A pick line's records as { customer: pallets }.
  const byCustomer = (rows: Awaited<ReturnType<typeof recordsOn>>) =>
    Object.fromEntries(rows.map((row) => [row.customer_company_id, Number(row.quantity_pallets)]));

  // Another grower, created BEFORE the day for the same two reasons as above:
  // initiate_business_day gives them a pick, and the day goes before they do.
  async function anotherGrower() {
    const grower = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    return grower;
  }

  async function pickLineOn(
    tradingDayId: string,
    grower: TestGrowerWithProduct,
    productVarietyId: string,
  ) {
    const pick = await getDailyPickForGrower(tradingDayId, grower.companyId);
    const line = await getPickProductLine(pick!.id, productVarietyId);
    return line!.id;
  }

  // A second lot of a product the day already has: the grower takes the
  // product up too, the day's picks are brought up to date, and they pick
  // `palletsPicked` of it.
  async function addLotOfSameProduct(
    tradingDayId: string,
    grower: TestGrowerWithProduct,
    productVarietyId: string,
    palletsPicked: number,
  ) {
    await db.insert(growerProducts).values({ companyId: grower.companyId, productVarietyId });
    const synced = await admin.client.rpc("update_growers_data");
    expect(synced.error).toBeNull();
    const lineId = await pickLineOn(tradingDayId, grower, productVarietyId);
    const updatePallets = await admin.client.rpc(
      "update_pick_product_pallets",
      toUpdatePickProductPalletsRpcArgs({ dailyPickProductId: lineId, palletsPicked }),
    );
    expect(updatePallets.error).toBeNull();
    return lineId;
  }

  async function orderLinesOf(tradingDayId: string, customerCompanyId: string) {
    return db
      .select({
        id: dailyOrderProducts.id,
        productVarietyId: dailyOrderProducts.productVarietyId,
        palletsOrdered: dailyOrderProducts.palletsOrdered,
      })
      .from(dailyOrderProducts)
      .innerJoin(dailyOrders, eq(dailyOrders.id, dailyOrderProducts.dailyOrderId))
      .where(
        and(
          eq(dailyOrders.tradingDayId, tradingDayId),
          eq(dailyOrders.customerCompanyId, customerCompanyId),
        ),
      );
  }

  // An earlier day, over but for its arrangement, which is still open: a pick
  // line of the grower's on it, to which the day under test must not reach.
  async function setUpEarlierDay(growerCompanyId: string, productVarietyId: string) {
    const day = await createTestTradingDay({
      initiatedByUserId: admin.userId,
      phase: "closed",
      tradeDate: "2020-01-01",
    });
    cleanupFns.push(() => deleteTestTradingDay(day.id));
    await db.insert(dailyArrangements).values({ tradingDayId: day.id });
    const [pick] = await db
      .insert(dailyPicks)
      .values({ tradingDayId: day.id, growerCompanyId })
      .returning();
    const [line] = await db
      .insert(dailyPickProducts)
      .values({ dailyPickId: pick!.id, productVarietyId, palletsPicked: "5" })
      .returning();
    return { day, pickProductId: line!.id };
  }

  // A signed-in user the way a half-finished invitation leaves one: an Auth
  // account with no profile, so current_role() is NULL for them.
  async function signedInWithoutProfile() {
    const email = `test-${crypto.randomUUID()}@example.test`;
    const password = `Correct-Horse-${crypto.randomUUID()}`;
    const created = await createServiceRoleClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error).toBeNull();
    cleanupFns.push(() => deleteTestUser(created.data.user!.id));
    return signInTestUser(email, password);
  }

  // What a save has to wait on: runs `hold` in a transaction of its own, starts
  // the save while that transaction is still open, gives the save a second to
  // run into whatever `hold` took, then runs `finish` and commits.
  type Held = Parameters<Parameters<typeof db.transaction>[0]>[0];

  async function saveWhileHeld(
    tradingDayId: string,
    allocations: Json,
    hold: (tx: Held) => Promise<unknown>,
    finish: (tx: Held) => Promise<unknown> = async () => undefined,
  ) {
    let returned = false;
    let returnedWhileHeld = false;
    let saving: Promise<Awaited<ReturnType<typeof saveRaw>>> | undefined;
    await db.transaction(async (tx) => {
      await hold(tx);
      saving = Promise.resolve(saveRaw(tradingDayId, allocations)).then((result) => {
        returned = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      returnedWhileHeld = returned;
      await finish(tx);
    });
    return { saved: await saving!, returnedWhileHeld };
  }

  it("save_arrangement_proposal saves every cell, a push included, and says how many", async () => {
    const pushedTo = await customerWhoOrdersNothing();
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);

    const saved = await admin.client.rpc(
      "save_arrangement_proposal",
      toSaveArrangementProposalRpcArgs({
        tradingDayId: day.id,
        allocations: [
          { dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 3 },
          { dailyPickProductId: pickProductId, customerCompanyId: pushedTo.id, quantityPallets: 2 },
        ],
      }),
    );

    expect(saved.error).toBeNull();
    expect(saved.data).toBe(2);
    const records = await recordsOn(pickProductId);
    expect(records.map((record) => Number(record.quantity_pallets)).sort()).toEqual([2, 3]);
  }, 30000);

  it("save_arrangement_proposal saves nothing when one cell is refused, and names that cell", async () => {
    const pushedTo = await customerWhoOrdersNothing();
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 10);

    // 3 + 4 off a lot of 5: the first cell fits, the second does not.
    const saved = await admin.client.rpc(
      "save_arrangement_proposal",
      toSaveArrangementProposalRpcArgs({
        tradingDayId: day.id,
        allocations: [
          { dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 3 },
          { dailyPickProductId: pickProductId, customerCompanyId: pushedTo.id, quantityPallets: 4 },
        ],
      }),
    );

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.OVER_ALLOCATION);
    expect(JSON.parse(saved.error?.details ?? "{}")).toMatchObject({
      index: 1,
      dailyPickProductId: pickProductId,
      customerCompanyId: pushedTo.id,
    });
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses a cell filled since the proposal was read, and leaves it as it was", async () => {
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const typed = await admin.client.rpc("arrange_to_customer", {
      p_daily_pick_product_id: pickProductId,
      p_customer_company_id: customer.id,
      p_quantity_pallets: 1,
    });
    expect(typed.error).toBeNull();

    const saved = await admin.client.rpc(
      "save_arrangement_proposal",
      toSaveArrangementProposalRpcArgs({
        tradingDayId: day.id,
        allocations: [
          { dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 3 },
        ],
      }),
    );

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    const records = await recordsOn(pickProductId);
    expect(records.map((record) => Number(record.quantity_pallets))).toEqual([1]);
  }, 30000);

  it("save_arrangement_proposal refuses a cell meant for an order the customer no longer has, and saves nothing", async () => {
    // The proposal was worked out while the customer still had an order; it
    // has gone since. Without the mark the same cell is a push, and is saved
    // (see the first case); with it, the whole save is refused.
    const withdrawn = await customerWhoOrdersNothing();
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);

    const saved = await admin.client.rpc(
      "save_arrangement_proposal",
      toSaveArrangementProposalRpcArgs({
        tradingDayId: day.id,
        allocations: [
          {
            dailyPickProductId: pickProductId,
            customerCompanyId: customer.id,
            quantityPallets: 2,
            forOrder: true,
          },
          {
            dailyPickProductId: pickProductId,
            customerCompanyId: withdrawn.id,
            quantityPallets: 1,
            forOrder: true,
          },
        ],
      }),
    );

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    expect(JSON.parse(saved.error?.details ?? "{}")).toMatchObject({
      cells: [{ index: 1, dailyPickProductId: pickProductId, customerCompanyId: withdrawn.id }],
    });
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal holds one customer to their order across two lots of the same product, saves nothing, and names the second cell", async () => {
    const secondGrower = await anotherGrower();
    const {
      day,
      grower,
      pickProductId: firstLot,
      customer,
    } = await setUpDayWithSupplyAndDemand(5, 6);
    const secondLot = await addLotOfSameProduct(day.id, secondGrower, grower.varietyId, 5);

    // 4 + 4 against an order of 6: each cell fits its lot and the order on its
    // own, the two together do not.
    const saved = await admin.client.rpc(
      "save_arrangement_proposal",
      toSaveArrangementProposalRpcArgs({
        tradingDayId: day.id,
        allocations: [
          { dailyPickProductId: firstLot, customerCompanyId: customer.id, quantityPallets: 4 },
          { dailyPickProductId: secondLot, customerCompanyId: customer.id, quantityPallets: 4 },
        ],
      }),
    );

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.OVER_ALLOCATION);
    expect(saved.error?.message).toContain("pallets ordered");
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({
      index: 1,
      dailyPickProductId: secondLot,
      customerCompanyId: customer.id,
      quantityPallets: 4,
    });
    expect(await recordsOn(firstLot)).toEqual([]);
    expect(await recordsOn(secondLot)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses a push to a customer with no order for the day, saves nothing, and names that cell", async () => {
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    // Joined after the shop opened, so open_shop gave them no order header.
    const latecomer = await createTestCompany(`לקוח בדיקה ${crypto.randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(latecomer.id));

    const saved = await admin.client.rpc(
      "save_arrangement_proposal",
      toSaveArrangementProposalRpcArgs({
        tradingDayId: day.id,
        allocations: [
          { dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 3 },
          {
            dailyPickProductId: pickProductId,
            customerCompanyId: latecomer.id,
            quantityPallets: 1,
          },
        ],
      }),
    );

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.NOT_FOUND);
    expect(JSON.parse(saved.error?.details ?? "{}")).toMatchObject({
      index: 1,
      dailyPickProductId: pickProductId,
      customerCompanyId: latecomer.id,
    });
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses anyone but backoffice, and saves nothing", async () => {
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const customerProfile = await createTestProfile({ companyId: customer.id, role: "customer" });
    cleanupFns.push(() => deleteTestUser(customerProfile.userId));

    const outsiders = [
      [
        "a customer",
        await signInTestUser(customerProfile.email, customerProfile.password),
        /FORBIDDEN/,
      ],
      ["a user with no profile", await signedInWithoutProfile(), /FORBIDDEN/],
      // Turned away before the function runs at all.
      ["a visitor who is not signed in", createAnonClient(), /permission denied/],
    ] as const;

    for (const [who, client, refusal] of outsiders) {
      const saved = await client.rpc(
        "save_arrangement_proposal",
        toSaveArrangementProposalRpcArgs({
          tradingDayId: day.id,
          allocations: [
            {
              dailyPickProductId: pickProductId,
              customerCompanyId: customer.id,
              quantityPallets: 3,
            },
          ],
        }),
      );
      expect(saved.error?.code, who).toBe(ARRANGEMENT_ERROR_CODES.FORBIDDEN);
      expect(saved.error?.message, who).toMatch(refusal);
    }
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses an arrangement that closed since the proposal was read, and saves nothing", async () => {
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const closeShop = await admin.client.rpc("close_shop");
    expect(closeShop.error).toBeNull();
    const closeArrangement = await admin.client.rpc("close_arrangement");
    expect(closeArrangement.error).toBeNull();

    const saved = await admin.client.rpc(
      "save_arrangement_proposal",
      toSaveArrangementProposalRpcArgs({
        tradingDayId: day.id,
        allocations: [
          { dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 3 },
        ],
      }),
    );

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_STATE);
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses a trading day that does not exist", async () => {
    const saved = await saveRaw(crypto.randomUUID(), [
      {
        dailyPickProductId: crypto.randomUUID(),
        customerCompanyId: crypto.randomUUID(),
        quantityPallets: 1,
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.NOT_FOUND);
  }, 30000);

  it("save_arrangement_proposal refuses a pick line that is on another day, names it, and saves nothing on either day", async () => {
    const { day, grower, customer, pickProductId } = await setUpDayWithSupplyAndDemand(5, 3);
    // The customer has an order and an open arrangement waits on the earlier
    // day, so nothing but the day check stands between this cell and a save.
    const earlier = await setUpEarlierDay(grower.companyId, grower.varietyId);
    await createTestOrderProductLine(earlier.day.id, customer.id, grower.varietyId, 3);

    const saved = await saveRaw(day.id, [
      { dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 1 },
      {
        dailyPickProductId: earlier.pickProductId,
        customerCompanyId: customer.id,
        quantityPallets: 1,
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.NOT_FOUND);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({
      pickLineIds: [earlier.pickProductId],
    });
    expect(await recordsOn(pickProductId)).toEqual([]);
    expect(await recordsOn(earlier.pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses a forOrder that is not true or false, naming every such allocation by position, and saves nothing", async () => {
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const cell = {
      dailyPickProductId: pickProductId,
      customerCompanyId: customer.id,
      quantityPallets: 1,
    };

    const saved = await saveRaw(day.id, [
      cell,
      { ...cell, forOrder: "true" },
      { ...cell, forOrder: 1 },
      { ...cell, forOrder: null },
      { ...cell, forOrder: true },
      { ...cell, forOrder: false },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_INPUT);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({ indexes: [1, 2, 3] });
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses an allocation that is not a pick line, a customer and a number of pallets above zero with at most one decimal place, naming every one by position, and saves nothing", async () => {
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const cell = {
      dailyPickProductId: pickProductId,
      customerCompanyId: customer.id,
      quantityPallets: 1,
    };

    const saved = await saveRaw(day.id, [
      cell,
      { ...cell, quantityPallets: 0 },
      { ...cell, quantityPallets: -2 },
      { ...cell, quantityPallets: 1.55 },
      { ...cell, quantityPallets: "2" },
      { dailyPickProductId: pickProductId, customerCompanyId: customer.id },
      { ...cell, dailyPickProductId: "not-a-uuid" },
      { ...cell, dailyPickProductId: `${pickProductId}0` },
      { ...cell, dailyPickProductId: `0${pickProductId}` },
      { ...cell, customerCompanyId: `${customer.id}0` },
      { ...cell, customerCompanyId: `0${customer.id}` },
      { ...cell, dailyPickProductId: null },
      { ...cell, customerCompanyId: null },
      { quantityPallets: 1, customerCompanyId: customer.id },
      { quantityPallets: 1, dailyPickProductId: pickProductId },
      7,
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_INPUT);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({
      indexes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    });
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  // Workbook Task 35 (migration 0085): an arrangement may be part of a
  // pallet, to one decimal place — by a single cell and by a proposal alike.
  it("arranges part of a pallet to one decimal place and refuses a finer one, from arrange_to_customer and save_arrangement_proposal alike", async () => {
    const second = await customerWhoOrdersNothing();
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);

    const finer = await admin.client.rpc("arrange_to_customer", {
      p_daily_pick_product_id: pickProductId,
      p_customer_company_id: customer.id,
      p_quantity_pallets: 0.45,
    });
    expect(finer.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_INPUT);
    expect(await recordsOn(pickProductId)).toEqual([]);

    const tenth = await admin.client.rpc("arrange_to_customer", {
      p_daily_pick_product_id: pickProductId,
      p_customer_company_id: customer.id,
      p_quantity_pallets: 0.4,
    });
    expect(tenth.error).toBeNull();

    const finerProposal = await saveRaw(day.id, [
      { dailyPickProductId: pickProductId, customerCompanyId: second.id, quantityPallets: 1.55 },
    ]);
    expect(finerProposal.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_INPUT);

    const proposal = await saveRaw(day.id, [
      { dailyPickProductId: pickProductId, customerCompanyId: second.id, quantityPallets: 1.5 },
    ]);
    expect(proposal.error).toBeNull();

    const quantities = (await recordsOn(pickProductId))
      .map((record) => Number(record.quantity_pallets))
      .sort((a, b) => a - b);
    expect(quantities).toEqual([0.4, 1.5]);
  }, 30000);

  it("save_arrangement_proposal refuses allocations that are not a list, and saves nothing", async () => {
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const cell = {
      dailyPickProductId: pickProductId,
      customerCompanyId: customer.id,
      quantityPallets: 1,
    };

    // The last is a single allocation, sent without the list round it.
    for (const [what, notAList] of [
      ["an empty object", {}],
      ["text", "text"],
      ["a number", 7],
      ["nothing", null],
      ["one allocation", cell],
    ] as const) {
      const saved = await saveRaw(day.id, notAList);
      expect(saved.error?.code, what).toBe(ARRANGEMENT_ERROR_CODES.INVALID_INPUT);
    }
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses a cell that appears twice, naming it, and saves nothing", async () => {
    const pushedTo = await customerWhoOrdersNothing();
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);

    // The first and the third are the same cell; the second is another
    // customer on the same pick line, which is not a repeat.
    const saved = await saveRaw(day.id, [
      { dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 1 },
      { dailyPickProductId: pickProductId, customerCompanyId: pushedTo.id, quantityPallets: 1 },
      { dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 2 },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_INPUT);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({
      cells: [{ dailyPickProductId: pickProductId, customerCompanyId: customer.id }],
    });
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal reads ids in capitals as the same ids, saving the cell and counting a repeat", async () => {
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const inCapitals = {
      dailyPickProductId: pickProductId.toUpperCase(),
      customerCompanyId: customer.id.toUpperCase(),
      quantityPallets: 2,
    };

    // The same cell written both ways is a repeat, and nothing is saved.
    const repeated = await saveRaw(day.id, [
      { dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 1 },
      inCapitals,
    ]);
    expect(repeated.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_INPUT);
    expect(await recordsOn(pickProductId)).toEqual([]);

    const saved = await saveRaw(day.id, [inCapitals]);
    expect(saved.error).toBeNull();
    expect(saved.data).toBe(1);
    const records = await recordsOn(pickProductId);
    expect(records.map((record) => record.customer_company_id)).toEqual([customer.id]);
  }, 30000);

  it("save_arrangement_proposal refuses every cell already filled, whether the record's order line or the record's own customer says so, and saves nothing", async () => {
    const copiedTo = await customerWhoOrdersNothing();
    const empty = await customerWhoOrdersNothing();
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const typed = await admin.client.rpc("arrange_to_customer", {
      p_daily_pick_product_id: pickProductId,
      p_customer_company_id: customer.id,
      p_quantity_pallets: 1,
    });
    expect(typed.error).toBeNull();
    // The record hangs off the customer's order line but names another
    // customer as its own, as the grid also reads it.
    const copied = await admin.client
      .from("arrangement_records")
      .update({ customer_company_id: copiedTo.id })
      .eq("id", typed.data!.id);
    expect(copied.error).toBeNull();

    const saved = await admin.client.rpc(
      "save_arrangement_proposal",
      toSaveArrangementProposalRpcArgs({
        tradingDayId: day.id,
        allocations: [
          { dailyPickProductId: pickProductId, customerCompanyId: empty.id, quantityPallets: 1 },
          { dailyPickProductId: pickProductId, customerCompanyId: copiedTo.id, quantityPallets: 1 },
          { dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 1 },
        ],
      }),
    );

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({
      cells: [
        { index: 1, dailyPickProductId: pickProductId, customerCompanyId: copiedTo.id },
        { index: 2, dailyPickProductId: pickProductId, customerCompanyId: customer.id },
      ],
    });
    const records = await recordsOn(pickProductId);
    expect(records.map((record) => record.id)).toEqual([typed.data!.id]);
    expect(records.map((record) => Number(record.quantity_pallets))).toEqual([1]);
  }, 30000);

  it("save_arrangement_proposal saves a cell marked for an order the customer still has, and leaves the order as it was", async () => {
    const { day, pickProductId, customer, orderProductId } = await setUpDayWithSupplyAndDemand(
      5,
      3,
    );

    const saved = await admin.client.rpc(
      "save_arrangement_proposal",
      toSaveArrangementProposalRpcArgs({
        tradingDayId: day.id,
        allocations: [
          {
            dailyPickProductId: pickProductId,
            customerCompanyId: customer.id,
            quantityPallets: 3,
            forOrder: true,
          },
        ],
      }),
    );

    expect(saved.error).toBeNull();
    expect(saved.data).toBe(1);
    const records = await recordsOn(pickProductId);
    expect(records.map((record) => Number(record.quantity_pallets))).toEqual([3]);
    const lines = await orderLinesOf(day.id, customer.id);
    expect(lines.map((line) => [line.id, Number(line.palletsOrdered)])).toEqual([
      [orderProductId, 3],
    ]);
  }, 30000);

  it("save_arrangement_proposal saves a cell with no mark, or marked false, as a push to a customer who ordered nothing, giving them a zero-pallet order line", async () => {
    const unmarked = await customerWhoOrdersNothing();
    const markedFalse = await customerWhoOrdersNothing();
    const { day, grower, pickProductId } = await setUpDayWithSupplyAndDemand(5, 3);
    expect(await orderLinesOf(day.id, unmarked.id)).toEqual([]);
    expect(await orderLinesOf(day.id, markedFalse.id)).toEqual([]);

    const saved = await saveRaw(day.id, [
      { dailyPickProductId: pickProductId, customerCompanyId: unmarked.id, quantityPallets: 2 },
      {
        dailyPickProductId: pickProductId,
        customerCompanyId: markedFalse.id,
        quantityPallets: 1,
        forOrder: false,
      },
    ]);

    expect(saved.error).toBeNull();
    expect(saved.data).toBe(2);
    const records = await recordsOn(pickProductId);
    for (const [pushedTo, pallets] of [
      [unmarked, 2],
      [markedFalse, 1],
    ] as const) {
      const lines = await orderLinesOf(day.id, pushedTo.id);
      expect(lines.map((line) => [line.productVarietyId, Number(line.palletsOrdered)])).toEqual([
        [grower.varietyId, 0],
      ]);
      const theirs = records.filter((record) => record.customer_company_id === pushedTo.id);
      expect(theirs.map((record) => Number(record.quantity_pallets))).toEqual([pallets]);
    }
  }, 30000);

  it("save_arrangement_proposal refuses a cell marked for an order whose line was left at zero, and saves nothing", async () => {
    // What a withdrawn order leaves behind when something was arranged against it.
    const withdrawn = await customerWhoOrdersNothing();
    const { day, grower, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    await createTestOrderProductLine(day.id, withdrawn.id, grower.varietyId, 0);

    const saved = await saveRaw(day.id, [
      {
        dailyPickProductId: pickProductId,
        customerCompanyId: customer.id,
        quantityPallets: 2,
        forOrder: true,
      },
      {
        dailyPickProductId: pickProductId,
        customerCompanyId: withdrawn.id,
        quantityPallets: 1,
        forOrder: true,
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({
      cells: [{ index: 1, dailyPickProductId: pickProductId, customerCompanyId: withdrawn.id }],
    });
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses a cell marked for an order when the customer's order is for another product, and saves nothing", async () => {
    const otherGrower = await anotherGrower();
    const { day, grower, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    // The customer ordered the first grower's product, not this one.
    const otherLine = await pickLineOn(day.id, otherGrower, otherGrower.varietyId);
    const updatePallets = await admin.client.rpc(
      "update_pick_product_pallets",
      toUpdatePickProductPalletsRpcArgs({ dailyPickProductId: otherLine, palletsPicked: 5 }),
    );
    expect(updatePallets.error).toBeNull();
    expect((await orderLinesOf(day.id, customer.id)).map((line) => line.productVarietyId)).toEqual([
      grower.varietyId,
    ]);

    const saved = await saveRaw(day.id, [
      {
        dailyPickProductId: otherLine,
        customerCompanyId: customer.id,
        quantityPallets: 1,
        forOrder: true,
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({
      cells: [{ index: 0, dailyPickProductId: otherLine, customerCompanyId: customer.id }],
    });
    expect(await recordsOn(otherLine)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses a cell marked for an order the customer had only on an earlier day, and saves nothing", async () => {
    const withdrawn = await customerWhoOrdersNothing();
    const { day, grower, pickProductId } = await setUpDayWithSupplyAndDemand(5, 3);
    const earlier = await setUpEarlierDay(grower.companyId, grower.varietyId);
    await createTestOrderProductLine(earlier.day.id, withdrawn.id, grower.varietyId, 4);

    const saved = await saveRaw(day.id, [
      {
        dailyPickProductId: pickProductId,
        customerCompanyId: withdrawn.id,
        quantityPallets: 1,
        forOrder: true,
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    expect(await recordsOn(pickProductId)).toEqual([]);
    expect(await orderLinesOf(day.id, withdrawn.id)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal saves a customer's cell on one lot though they already hold a cell on another lot of the same product", async () => {
    const secondGrower = await anotherGrower();
    const {
      day,
      grower,
      pickProductId: firstLot,
      customer,
    } = await setUpDayWithSupplyAndDemand(5, 6);
    const secondLot = await addLotOfSameProduct(day.id, secondGrower, grower.varietyId, 5);
    const typed = await admin.client.rpc("arrange_to_customer", {
      p_daily_pick_product_id: firstLot,
      p_customer_company_id: customer.id,
      p_quantity_pallets: 2,
    });
    expect(typed.error).toBeNull();

    const saved = await admin.client.rpc(
      "save_arrangement_proposal",
      toSaveArrangementProposalRpcArgs({
        tradingDayId: day.id,
        allocations: [
          { dailyPickProductId: secondLot, customerCompanyId: customer.id, quantityPallets: 3 },
        ],
      }),
    );

    expect(saved.error).toBeNull();
    expect(saved.data).toBe(1);
    expect((await recordsOn(firstLot)).map((record) => Number(record.quantity_pallets))).toEqual([
      2,
    ]);
    expect((await recordsOn(secondLot)).map((record) => Number(record.quantity_pallets))).toEqual([
      3,
    ]);
  }, 30000);

  it("save_arrangement_proposal waits for a close that is under way, and is refused once the arrangement has closed", async () => {
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);

    // As close_arrangement does: the trading day locked first, the
    // arrangement closed last.
    const { saved, returnedWhileHeld } = await saveWhileHeld(
      day.id,
      [{ dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 3 }],
      (tx) => tx.select().from(tradingDays).where(eq(tradingDays.id, day.id)).for("update"),
      (tx) =>
        tx
          .update(dailyArrangements)
          .set({ status: "closed", closedAt: new Date() })
          .where(eq(dailyArrangements.tradingDayId, day.id)),
    );

    expect(returnedWhileHeld).toBe(false);
    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_STATE);
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal waits while a pick line is being lowered, and is held to the lowered figure", async () => {
    const { day, pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 3);

    // 3 pallets fit the 5 picked; they do not fit the 1 the grower lowers it to.
    const { saved, returnedWhileHeld } = await saveWhileHeld(
      day.id,
      [{ dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 3 }],
      (tx) =>
        tx
          .update(dailyPickProducts)
          .set({ palletsPicked: "1" })
          .where(eq(dailyPickProducts.id, pickProductId)),
    );

    expect(returnedWhileHeld).toBe(false);
    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.OVER_ALLOCATION);
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal waits while a customer's order is being changed, and refuses a cell marked for the order that went", async () => {
    const { day, pickProductId, customer, orderProductId } = await setUpDayWithSupplyAndDemand(
      5,
      3,
    );

    // As submit_order does: the customer's order header locked, then its lines
    // changed — here the customer withdraws the line.
    const { saved, returnedWhileHeld } = await saveWhileHeld(
      day.id,
      [
        {
          dailyPickProductId: pickProductId,
          customerCompanyId: customer.id,
          quantityPallets: 3,
          forOrder: true,
        },
      ],
      (tx) =>
        tx
          .select()
          .from(dailyOrders)
          .where(
            and(
              eq(dailyOrders.tradingDayId, day.id),
              eq(dailyOrders.customerCompanyId, customer.id),
            ),
          )
          .for("update"),
      (tx) =>
        tx
          .update(dailyOrderProducts)
          .set({ palletsOrdered: "0" })
          .where(eq(dailyOrderProducts.id, orderProductId)),
    );

    expect(returnedWhileHeld).toBe(false);
    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({
      cells: [{ index: 0, dailyPickProductId: pickProductId, customerCompanyId: customer.id }],
    });
    expect(await recordsOn(pickProductId)).toEqual([]);
  }, 30000);

  it("save_arrangement_proposal refuses a cell another writer filled while it waited for the arrangement, and leaves their record as it was", async () => {
    const { day, pickProductId, customer, orderProductId } = await setUpDayWithSupplyAndDemand(
      5,
      3,
    );
    const [arrangement] = await db
      .select()
      .from(dailyArrangements)
      .where(eq(dailyArrangements.tradingDayId, day.id));

    // Another writer holds the arrangement (as every arrangement-record writer
    // does), and fills the cell before letting go.
    const { saved, returnedWhileHeld } = await saveWhileHeld(
      day.id,
      [{ dailyPickProductId: pickProductId, customerCompanyId: customer.id, quantityPallets: 3 }],
      (tx) =>
        tx
          .select()
          .from(dailyArrangements)
          .where(eq(dailyArrangements.id, arrangement!.id))
          .for("update"),
      (tx) =>
        tx.insert(arrangementRecords).values({
          dailyArrangementId: arrangement!.id,
          dailyPickProductId: pickProductId,
          dailyOrderProductId: orderProductId,
          customerCompanyId: customer.id,
          quantityPallets: "1",
        }),
    );

    expect(returnedWhileHeld).toBe(false);
    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    const records = await recordsOn(pickProductId);
    expect(records.map((record) => Number(record.quantity_pallets))).toEqual([1]);
  }, 30000);

  it("save_arrangement_changes saves a new, a changed and a cleared cell in one call, and says how many", async () => {
    const c2 = await customerWhoOrdersNothing();
    const c3 = await customerWhoOrdersNothing();
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(10, 3);
    const r2 = await arrangeNow(line, c2.id, 2);
    const r3 = await arrangeNow(line, c3.id, 1);

    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 3,
        expected: EMPTY,
      },
      {
        dailyPickProductId: line,
        customerCompanyId: c2.id,
        quantityPallets: 4,
        expected: { recordId: r2.id, quantityPallets: 2 },
      },
      {
        dailyPickProductId: line,
        customerCompanyId: c3.id,
        quantityPallets: 0,
        expected: { recordId: r3.id, quantityPallets: 1 },
      },
    ]);

    expect(saved.error).toBeNull();
    expect(saved.data).toBe(3);
    expect(byCustomer(await recordsOn(line))).toEqual({ [customer.id]: 3, [c2.id]: 4 });
  }, 30000);

  it("save_arrangement_changes saves nothing when one cell is refused, and names that cell", async () => {
    const c2 = await customerWhoOrdersNothing();
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 10);

    // 3 + 4 off a lot of 5: the first cell fits, the second does not.
    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 3,
        expected: EMPTY,
      },
      { dailyPickProductId: line, customerCompanyId: c2.id, quantityPallets: 4, expected: EMPTY },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.OVER_ALLOCATION);
    expect(JSON.parse(saved.error?.details ?? "{}")).toMatchObject({
      index: 1,
      dailyPickProductId: line,
      customerCompanyId: c2.id,
    });
    expect(await recordsOn(line)).toEqual([]);
  }, 30000);

  it("save_arrangement_changes refuses a cell filled since it was typed into, names it, and leaves it as it was", async () => {
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    // Someone else fills the cell after this screen read it empty.
    await arrangeNow(line, customer.id, 1);

    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 3,
        expected: EMPTY,
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    expect(JSON.parse(saved.error?.details ?? "{}").cells).toEqual([
      { index: 0, dailyPickProductId: line, customerCompanyId: customer.id },
    ]);
    expect(byCustomer(await recordsOn(line))).toEqual({ [customer.id]: 1 });
  }, 30000);

  it("save_arrangement_changes refuses cells changed or emptied since they were typed over, naming every one, and saves nothing", async () => {
    const c2 = await customerWhoOrdersNothing();
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(10, 5);
    const r1 = await arrangeNow(line, customer.id, 3);
    const r2 = await arrangeNow(line, c2.id, 2);
    // After this screen read them, somebody changed the first cell and
    // emptied the second.
    await arrangeNow(line, customer.id, 4);
    const emptied = await admin.client.rpc(
      "delete_arrangement_record",
      toDeleteArrangementRecordRpcArgs({ id: r2.id }),
    );
    expect(emptied.error).toBeNull();

    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 5,
        expected: { recordId: r1.id, quantityPallets: 3 },
      },
      {
        dailyPickProductId: line,
        customerCompanyId: c2.id,
        quantityPallets: 1,
        expected: { recordId: r2.id, quantityPallets: 2 },
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    expect(
      JSON.parse(saved.error?.details ?? "{}").cells.map((cell: { index: number }) => cell.index),
    ).toEqual([0, 1]);
    expect(byCustomer(await recordsOn(line))).toEqual({ [customer.id]: 4 });
  }, 30000);

  it("save_arrangement_changes moves pallets between two customers on a lot with nothing free, whichever is listed first", async () => {
    const c2 = await customerWhoOrdersNothing();
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 5);
    const r1 = await arrangeNow(line, customer.id, 5);

    // All 5 pallets are the customer's; 3 of them go to c2. The increase is
    // listed first, and still the decrease must be applied first.
    const saved = await saveChanges(day.id, [
      { dailyPickProductId: line, customerCompanyId: c2.id, quantityPallets: 3, expected: EMPTY },
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 2,
        expected: { recordId: r1.id, quantityPallets: 5 },
      },
    ]);

    expect(saved.error).toBeNull();
    expect(byCustomer(await recordsOn(line))).toEqual({ [customer.id]: 2, [c2.id]: 3 });
  }, 30000);

  it("save_arrangement_changes refuses a cell meant for an order the customer withdrew, and saves nothing", async () => {
    // As for the proposal: the number was typed while the customer still had
    // an order for the product, and the order has gone since. Without the
    // mark the same cell would be saved as a push.
    const withdrawn = await customerWhoOrdersNothing();
    const { day, pickProductId: line } = await setUpDayWithSupplyAndDemand(5, 3);

    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: withdrawn.id,
        quantityPallets: 3,
        expected: EMPTY,
        forOrder: true,
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({
      cells: [{ index: 0, dailyPickProductId: line, customerCompanyId: withdrawn.id }],
    });
    expect(await recordsOn(line)).toEqual([]);
  }, 30000);

  it("save_arrangement_changes keeps the price on a cell whose quantity it changes", async () => {
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const r = await arrangeNow(line, customer.id, 2);
    const priced = await admin.client.rpc(
      "update_arrangement_record",
      toUpdateArrangementRecordRpcArgs({
        id: r.id,
        quantityPallets: 2,
        price: 12.5,
        priceType: PRICE_TYPES[0],
      }),
    );
    expect(priced.error).toBeNull();

    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 3,
        expected: { recordId: r.id, quantityPallets: 2 },
      },
    ]);

    expect(saved.error).toBeNull();
    const { data: record, error } = await admin.client
      .from("arrangement_records")
      .select("quantity_pallets, price, price_type")
      .eq("id", r.id)
      .single();
    expect(error).toBeNull();
    expect({
      quantityPallets: Number(record!.quantity_pallets),
      price: Number(record!.price),
      priceType: record!.price_type,
    }).toEqual({ quantityPallets: 3, price: 12.5, priceType: PRICE_TYPES[0] });
  }, 30000);

  it("save_arrangement_changes is refused on a closed pick, saving nothing", async () => {
    const { day, grower, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const closed = await admin.client.rpc("set_pick_closed", {
      p_daily_pick_id: (await getDailyPickForGrower(day.id, grower.companyId))!.id,
      p_closed: true,
    });
    expect(closed.error).toBeNull();

    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 2,
        expected: EMPTY,
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.PICK_CLOSED);
    expect(await recordsOn(line)).toEqual([]);
  }, 30000);

  it("save_arrangement_changes is refused once the arrangement has closed", async () => {
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    expect((await admin.client.rpc("close_shop")).error).toBeNull();
    expect((await admin.client.rpc("close_arrangement")).error).toBeNull();

    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 3,
        expected: EMPTY,
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_STATE);
  }, 30000);

  it("save_arrangement_changes refuses anyone but backoffice, and saves nothing", async () => {
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const args = toSaveArrangementChangesRpcArgs({
      tradingDayId: day.id,
      changes: [
        {
          dailyPickProductId: line,
          customerCompanyId: customer.id,
          quantityPallets: 3,
          expected: EMPTY,
        },
      ],
    });

    const outsiders = [
      ["a user with no profile", await signedInWithoutProfile(), /FORBIDDEN/],
      // Turned away before the function runs at all.
      ["a visitor who is not signed in", createAnonClient(), /permission denied/],
    ] as const;

    for (const [who, client, refusal] of outsiders) {
      const saved = await client.rpc("save_arrangement_changes", args);
      expect(saved.error?.code, who).toBe(ARRANGEMENT_ERROR_CODES.FORBIDDEN);
      expect(saved.error?.message, who).toMatch(refusal);
    }
    expect(await recordsOn(line)).toEqual([]);
  }, 30000);

  it("save_arrangement_changes refuses malformed changes, naming each by position", async () => {
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const cell = {
      dailyPickProductId: line,
      customerCompanyId: customer.id,
      quantityPallets: 1,
      expected: EMPTY,
    };

    const saved = await saveChangesRaw(day.id, [
      { ...cell, dailyPickProductId: "x" },
      { ...cell, quantityPallets: -1 },
      { ...cell, quantityPallets: 0.55 },
      // Clearing a cell that held nothing.
      { ...cell, quantityPallets: 0, expected: EMPTY },
      { dailyPickProductId: line, customerCompanyId: customer.id, quantityPallets: 1 },
      { ...cell, forOrder: "yes" },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_INPUT);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({ indexes: [0, 1, 2, 3, 4, 5] });
  }, 30000);

  it("save_arrangement_changes refuses a cell that appears twice, and changes that are not a list", async () => {
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const cell = {
      dailyPickProductId: line,
      customerCompanyId: customer.id,
      quantityPallets: 1,
      expected: EMPTY,
    };

    const repeated = await saveChangesRaw(day.id, [cell, { ...cell, quantityPallets: 2 }]);
    expect(repeated.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_INPUT);
    expect(JSON.parse(repeated.error?.details ?? "{}").cells).toHaveLength(1);

    const notAList = await saveChangesRaw(day.id, {});
    expect(notAList.error?.code).toBe(ARRANGEMENT_ERROR_CODES.INVALID_INPUT);
  }, 30000);

  it("save_arrangement_changes refuses a pick line on another day, naming it", async () => {
    const { day, grower, customer, pickProductId: line } = await setUpDayWithSupplyAndDemand(5, 3);
    // As for the proposal: the customer has an order and an open arrangement
    // waits on the earlier day, so nothing but the day check stands between
    // that cell and a save.
    const earlier = await setUpEarlierDay(grower.companyId, grower.varietyId);
    await createTestOrderProductLine(earlier.day.id, customer.id, grower.varietyId, 3);

    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 1,
        expected: EMPTY,
      },
      {
        dailyPickProductId: earlier.pickProductId,
        customerCompanyId: customer.id,
        quantityPallets: 1,
        expected: EMPTY,
      },
    ]);

    expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.NOT_FOUND);
    expect(JSON.parse(saved.error?.details ?? "{}")).toEqual({
      pickLineIds: [earlier.pickProductId],
    });
  }, 30000);

  it("save_arrangement_changes saves part of a pallet to one decimal place", async () => {
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 3);

    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 2.5,
        expected: EMPTY,
      },
    ]);

    expect(saved.error).toBeNull();
    expect((await recordsOn(line)).map((record) => Number(record.quantity_pallets))).toEqual([2.5]);
  }, 30000);

  it("save_arrangement_changes changes a cell whose saved record holds an old two-decimal quantity", async () => {
    const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 3);
    const r = await arrangeNow(line, customer.id, 2);
    // Written the way imported history is, by the database owner: the tenths
    // trigger (0085) lets such a write through.
    await db
      .update(arrangementRecords)
      .set({ quantityPallets: "2.65" })
      .where(eq(arrangementRecords.id, r.id));
    expect(byCustomer(await recordsOn(line))).toEqual({ [customer.id]: 2.65 });

    const saved = await saveChanges(day.id, [
      {
        dailyPickProductId: line,
        customerCompanyId: customer.id,
        quantityPallets: 3,
        expected: { recordId: r.id, quantityPallets: 2.65 },
      },
    ]);

    expect(saved.error).toBeNull();
    const records = await recordsOn(line);
    expect(records.map((record) => [record.id, Number(record.quantity_pallets)])).toEqual([
      [r.id, 3],
    ]);
  }, 30000);

  it("update_arrangement_record excludes its own prior quantity from the ceiling; delete_arrangement_record frees it back up", async () => {
    const { pickProductId, orderProductId } = await setUpDayWithSupplyAndDemand(5, 5);

    const created = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 5,
      }),
    );
    expect(created.error).toBeNull();
    const recordId = created.data!.id;

    // Re-affirming the SAME quantity (5) would self-block if the ceiling
    // check didn't exclude this record's own prior contribution — proves
    // p_excluding_record_id is actually wired through.
    const sameQuantity = await admin.client.rpc(
      "update_arrangement_record",
      toUpdateArrangementRecordRpcArgs({ id: recordId, quantityPallets: 5 }),
    );
    expect(sameQuantity.error).toBeNull();

    // Raising it further, with nothing else to arrange against, must still
    // be blocked — excluding this record's own quantity doesn't mean no
    // ceiling at all.
    const overCeiling = await admin.client.rpc(
      "update_arrangement_record",
      toUpdateArrangementRecordRpcArgs({ id: recordId, quantityPallets: 6 }),
    );
    expect(overCeiling.error).not.toBeNull();
    expect(overCeiling.error?.code).toBe(ARRANGEMENT_ERROR_CODES.OVER_ALLOCATION);

    const deleted = await admin.client.rpc(
      "delete_arrangement_record",
      toDeleteArrangementRecordRpcArgs({ id: recordId }),
    );
    expect(deleted.error).toBeNull();

    // With the record gone, the full ceiling is available again to a new
    // record.
    const recreated = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 5,
      }),
    );
    expect(recreated.error).toBeNull();
  }, 30000);

  it("close_arrangement closes the day even when an arranged product has no price or price range, leaving that record's price empty", async () => {
    const { day, customer, pickProductId, orderProductId } = await setUpDayWithSupplyAndDemand(
      5,
      5,
    );

    // createTestGrowerWithProduct's variety has neither `price` nor a
    // price_range_from/to pair set — exactly what close_arrangement used to
    // refuse with INVALID_STATE (P0007), keeping the day open until the
    // product was priced. The distributor's rule is now that the day always
    // closes (migration 0065; see docs/SCHEMA_DECISIONS.md), so this is an
    // ordinary close.
    const created = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 5,
      }),
    );
    expect(created.error).toBeNull();
    const recordId = created.data!.id;

    // The customer's order must be submitted (status <> 'open') for
    // build_notification_outbox to include them, as in the priced test below —
    // the outbox is written AFTER the pricing step, which is part of what
    // this test wants to see still happen.
    await db
      .update(dailyOrders)
      .set({ status: "submitted" })
      .where(
        and(eq(dailyOrders.tradingDayId, day.id), eq(dailyOrders.customerCompanyId, customer.id)),
      );

    const closeShop = await admin.client.rpc("close_shop");
    expect(closeShop.error).toBeNull();

    const closeArrangement = await admin.client.rpc("close_arrangement");
    expect(closeArrangement.error).toBeNull();

    // The day really closed: the trading day, its arrangement and every pick.
    const { data: dayAfter } = await admin.client
      .from("trading_days")
      .select("phase")
      .eq("id", day.id)
      .single();
    expect(dayAfter?.phase).toBe("closed");

    const { data: arrangementAfter } = await admin.client
      .from("daily_arrangements")
      .select("status")
      .eq("trading_day_id", day.id)
      .single();
    expect(arrangementAfter?.status).toBe("closed");

    const { data: picksAfter } = await admin.client
      .from("daily_picks")
      .select("status")
      .eq("trading_day_id", day.id);
    expect(picksAfter?.length).toBeGreaterThan(0);
    expect(picksAfter?.every((row) => row.status === "closed")).toBe(true);

    // Nothing was invented for the record that could not be priced: its price
    // is still empty.
    const { data: recordAfter } = await admin.client
      .from("arrangement_records")
      .select("price")
      .eq("id", recordId)
      .single();
    expect(recordAfter?.price).toBeNull();

    // Every step of close_arrangement that runs AFTER the pricing step
    // happened too: the end_the_day session (the function's LAST statement)
    // was logged once, and the notification_outbox rows were written. Both
    // are filtered to close_arrangement's own session_type / template_keys —
    // the close_shop call above and setUpDayWithSupplyAndDemand's open_shop
    // legitimately left rows of their own behind.
    const { count: sessionCount } = await admin.client
      .from("lifecycle_sessions")
      .select("id", { count: "exact", head: true })
      .eq("trading_day_id", day.id)
      .eq("session_type", "end_the_day");
    expect(sessionCount).toBe(1);

    const { data: outboxRows } = await admin.client
      .from("notification_outbox")
      .select("template_key, payload")
      .eq("trading_day_id", day.id);
    const closeArrangementRows = outboxRows?.filter((row) =>
      ["close_arrangement_customer", "close_arrangement_grower"].includes(row.template_key),
    );
    expect(closeArrangementRows?.map((row) => row.template_key).sort()).toEqual([
      "close_arrangement_customer",
      "close_arrangement_grower",
    ]);

    // The customer's line carries no price — the shop was opened with
    // can_see_prices on, so a price WOULD be there if the record had one —
    // rather than a made-up figure; compose_order_details_text then leaves
    // the amount out of the message.
    const customerRow = closeArrangementRows?.find(
      (row) => row.template_key === "close_arrangement_customer",
    );
    const customerLines = (customerRow?.payload as { lines: Array<{ price: number | null }> })
      .lines;
    expect(customerLines).toHaveLength(1);
    expect(customerLines[0]?.price).toBeNull();
  }, 30000);

  // 0043 rebuilt close_arrangement without 0024's call to
  // build_arrangement_alerts, so closing the day stopped creating the bell
  // alerts; 0077 restores it, and makes a repeat add nothing.
  it("close_arrangement writes one closing bell alert for every user of the customer and the grower, and building them again adds none", async () => {
    const { day, grower, customer, pickProductId, orderProductId } = await setUpDayWithSupplyAndDemand(5, 5);
    const customerUsers: Array<{ userId: string; email: string; password: string }> = [];
    for (let i = 0; i < 2; i++) {
      const user = await createTestProfile({ companyId: customer.id, role: "customer" });
      cleanupFns.push(() => deleteTestUser(user.userId));
      customerUsers.push(user);
    }
    const growerUser = await createTestProfile({ companyId: grower.companyId, role: "grower" });
    cleanupFns.push(() => deleteTestUser(growerUser.userId));

    const created = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 3,
      }),
    );
    expect(created.error).toBeNull();
    // Only a customer that SENT its order gets the customer alert.
    await db
      .update(dailyOrders)
      .set({ status: "submitted" })
      .where(and(eq(dailyOrders.tradingDayId, day.id), eq(dailyOrders.customerCompanyId, customer.id)));

    expect((await admin.client.rpc("close_shop")).error).toBeNull();
    expect((await admin.client.rpc("close_arrangement")).error).toBeNull();

    const closingAlerts = async () =>
      (
        await db
          .select({ userId: alerts.intendedForUserId, type: alerts.alertTypeId, pallets: alerts.numberForDisplay })
          .from(alerts)
          .where(eq(alerts.displayRecordId, day.id))
      )
        .filter((a) => [customerUsers[0]!.userId, customerUsers[1]!.userId, growerUser.userId].includes(a.userId))
        .sort((a, b) => `${a.type}${a.userId}`.localeCompare(`${b.type}${b.userId}`));
    const expected = [
      ...customerUsers.map((u) => ({ userId: u.userId, type: "00000000-0000-0000-0000-000000000001", pallets: "3.00" })),
      { userId: growerUser.userId, type: "00000000-0000-0000-0000-000000000002", pallets: "3.00" },
    ].sort((a, b) => `${a.type}${a.userId}`.localeCompare(`${b.type}${b.userId}`));
    expect(await closingAlerts()).toEqual(expected);

    // Repeat: nobody gets the same day's alert twice.
    const again = await admin.client.rpc("build_arrangement_alerts", { p_trading_day_id: day.id });
    expect(again.error).toBeNull();
    expect(again.data).toBe(0);
    expect(await closingAlerts()).toEqual(expected);

    // Each customer user sees their own alert in the bell.
    const customerClient = await signInTestUser(customerUsers[0]!.email, customerUsers[0]!.password);
    const own = await customerClient.from("alerts").select("alert_type_id, number_for_display").eq("display_record_id", day.id);
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ alert_type_id: "00000000-0000-0000-0000-000000000001", number_for_display: 3 }]);
  }, 45000);

  it("close_arrangement populates a priced arrangement record's price from the variety's fixed price, and writes a notification_outbox row for the customer", async () => {
    const { day, grower, customer, pickProductId, orderProductId } =
      await setUpDayWithSupplyAndDemand(5, 5);

    await db
      .update(productVarieties)
      .set({ price: "12.50" })
      .where(eq(productVarieties.id, grower.varietyId));

    const created = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 5,
      }),
    );
    expect(created.error).toBeNull();
    const recordId = created.data!.id;

    // The customer's order must actually be submitted (status <> 'open')
    // for build_notification_outbox to include them — matches the
    // source's own eligibility criterion (see 0022's header comment).
    await db
      .update(dailyOrders)
      .set({ status: "submitted" })
      .where(
        and(eq(dailyOrders.tradingDayId, day.id), eq(dailyOrders.customerCompanyId, customer.id)),
      );

    const closeShop = await admin.client.rpc("close_shop");
    expect(closeShop.error).toBeNull();

    const closeArrangement = await admin.client.rpc("close_arrangement");
    expect(closeArrangement.error).toBeNull();

    const { data: recordAfter } = await admin.client
      .from("arrangement_records")
      .select("price")
      .eq("id", recordId)
      .single();
    // PostgREST returns `numeric` columns as bare JSON numbers, not
    // decimal-preserving strings — see apps/web's customer/history page
    // for the same empirically-verified behavior.
    expect(recordAfter?.price).toBe(12.5);

    const { data: outboxRows } = await admin.client
      .from("notification_outbox")
      .select("recipient_type, recipient_company_id")
      .eq("trading_day_id", day.id);
    expect(outboxRows).toContainEqual({
      recipient_type: "customer",
      recipient_company_id: customer.id,
    });
    expect(outboxRows).toContainEqual({
      recipient_type: "grower",
      recipient_company_id: grower.companyId,
    });
  }, 30000);

  it("close_arrangement (migration 0083) keeps a price range as a range — no midpoint — and shows it to a customer allowed to see prices", async () => {
    const { day, grower, customer, pickProductId, orderProductId } =
      await setUpDayWithSupplyAndDemand(5, 5);
    await db
      .update(productVarieties)
      .set({ price: null, priceRangeFrom: "10", priceRangeTo: "12" })
      .where(eq(productVarieties.id, grower.varietyId));
    await db.update(companies).set({ canSeeProductPrices: true }).where(eq(companies.id, customer.id));

    const created = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({ dailyPickProductId: pickProductId, dailyOrderProductId: orderProductId, quantityPallets: 5 }),
    );
    expect(created.error).toBeNull();
    await db
      .update(dailyOrders)
      .set({ status: "submitted" })
      .where(and(eq(dailyOrders.tradingDayId, day.id), eq(dailyOrders.customerCompanyId, customer.id)));
    expect((await admin.client.rpc("close_shop")).error).toBeNull();
    expect((await admin.client.rpc("close_arrangement")).error).toBeNull();

    const { data: record } = await admin.client
      .from("arrangement_records")
      .select("price, price_range_from, price_range_to")
      .eq("id", created.data!.id)
      .single();
    expect(record).toEqual({ price: null, price_range_from: 10, price_range_to: 12 });

    const { data: rows } = await admin.client
      .from("notification_outbox")
      .select("payload")
      .eq("trading_day_id", day.id)
      .eq("template_key", "close_arrangement_customer")
      .eq("recipient_company_id", customer.id);
    const [line] = (rows?.[0]?.payload as { lines: Array<{ price: number | null; priceRangeFrom: number | null; priceRangeTo: number | null }> }).lines;
    expect(line).toMatchObject({ price: null, priceRangeFrom: 10, priceRangeTo: 12 });
  }, 30000);

  it("close_arrangement (migration 0100) gives a record its product's תקליט price type and no number, and the customer's line carries the type", async () => {
    const { day, grower, customer, pickProductId, orderProductId } =
      await setUpDayWithSupplyAndDemand(5, 5);
    // A price left on the product from before is hidden by its type, so it
    // is not copied.
    await db
      .update(productVarieties)
      .set({ priceType: "record_plus_1", price: "12.50", priceRangeFrom: null, priceRangeTo: null })
      .where(eq(productVarieties.id, grower.varietyId));
    await db.update(companies).set({ canSeeProductPrices: true }).where(eq(companies.id, customer.id));

    const created = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({ dailyPickProductId: pickProductId, dailyOrderProductId: orderProductId, quantityPallets: 5 }),
    );
    expect(created.error).toBeNull();
    await db
      .update(dailyOrders)
      .set({ status: "submitted" })
      .where(and(eq(dailyOrders.tradingDayId, day.id), eq(dailyOrders.customerCompanyId, customer.id)));
    expect((await admin.client.rpc("close_shop")).error).toBeNull();
    expect((await admin.client.rpc("close_arrangement")).error).toBeNull();

    const { data: record } = await admin.client
      .from("arrangement_records")
      .select("price, price_range_from, price_range_to, price_type")
      .eq("id", created.data!.id)
      .single();
    expect(record).toEqual({ price: null, price_range_from: null, price_range_to: null, price_type: "record_plus_1" });

    const { data: rows } = await admin.client
      .from("notification_outbox")
      .select("payload")
      .eq("trading_day_id", day.id)
      .eq("template_key", "close_arrangement_customer")
      .eq("recipient_company_id", customer.id);
    const [line] = (rows?.[0]?.payload as { lines: Array<Record<string, unknown>> }).lines;
    expect(line).toMatchObject({ price: null, priceRangeFrom: null, priceRangeTo: null, priceType: "record_plus_1" });
  }, 30000);

  it("a record's price type is one of the codes (migration 0100): free text is refused", async () => {
    const { pickProductId, orderProductId } = await setUpDayWithSupplyAndDemand(5, 5);
    const refused = await admin.client.rpc("create_arrangement_record", {
      p_daily_pick_product_id: pickProductId,
      p_daily_order_product_id: orderProductId,
      p_quantity_pallets: 1,
      p_price: null,
      p_price_type: "לפי גודל",
    });
    expect(refused.error?.code).toBe("22P02");
  }, 30000);

  it("close_arrangement does not cc a transporter when the grower has none assigned", async () => {
    const { day, grower, customer, pickProductId, orderProductId } =
      await setUpDayWithSupplyAndDemand(5, 5);
    await db
      .update(productVarieties)
      .set({ price: "12.50" })
      .where(eq(productVarieties.id, grower.varietyId));

    const created = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 5,
      }),
    );
    expect(created.error).toBeNull();

    await db
      .update(dailyOrders)
      .set({ status: "submitted" })
      .where(
        and(eq(dailyOrders.tradingDayId, day.id), eq(dailyOrders.customerCompanyId, customer.id)),
      );

    const closeShop = await admin.client.rpc("close_shop");
    expect(closeShop.error).toBeNull();
    const closeArrangement = await admin.client.rpc("close_arrangement");
    expect(closeArrangement.error).toBeNull();

    const { data: outboxRows } = await admin.client
      .from("notification_outbox")
      .select("recipient_type")
      .eq("trading_day_id", day.id);
    expect(outboxRows?.filter((row) => row.recipient_type === "transporter")).toHaveLength(0);
  }, 30000);

  // A transporter company assigned to the grower, with the cleanup it needs.
  // Pushed after setUpDayWithSupplyAndDemand's own registrations, so LIFO
  // runs it BEFORE the day itself is deleted — meaning the day's own
  // notification_outbox rows (including those addressed to the transporter)
  // still exist then, and notification_outbox.recipient_company_id has no ON
  // DELETE action (RESTRICT). Deleting those rows directly first avoids the
  // FK violation regardless of ordering — and avoids a thrown error aborting
  // the REST of runCleanup's LIFO chain (it doesn't catch), which is what
  // once left a trading day stuck.
  async function assignTransporter(growerCompanyId: string) {
    const transporter = await createTestCompany(`מוביל בדיקה ${crypto.randomUUID()}`, "transporter");
    cleanupFns.push(async () => {
      await db.delete(notificationOutbox).where(eq(notificationOutbox.recipientCompanyId, transporter.id));
      await db.update(companies).set({ transporterCompanyId: null }).where(eq(companies.id, growerCompanyId));
      await deleteTestCompany(transporter.id);
    });
    await db.update(companies).set({ transporterCompanyId: transporter.id }).where(eq(companies.id, growerCompanyId));
    return transporter;
  }

  it("close_arrangement sends the grower's assigned transporter its own message, naming the grower — id 8, migration 0081", async () => {
    const { day, grower, customer, pickProductId, orderProductId } =
      await setUpDayWithSupplyAndDemand(5, 5);
    await db
      .update(productVarieties)
      .set({ price: "12.50" })
      .where(eq(productVarieties.id, grower.varietyId));
    const transporter = await assignTransporter(grower.companyId);

    const created = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 5,
      }),
    );
    expect(created.error).toBeNull();

    await db
      .update(dailyOrders)
      .set({ status: "submitted" })
      .where(
        and(eq(dailyOrders.tradingDayId, day.id), eq(dailyOrders.customerCompanyId, customer.id)),
      );

    const closeShop = await admin.client.rpc("close_shop");
    expect(closeShop.error).toBeNull();
    const closeArrangement = await admin.client.rpc("close_arrangement");
    expect(closeArrangement.error).toBeNull();

    const { data: outboxRows } = await admin.client
      .from("notification_outbox")
      .select("recipient_type, recipient_company_id, template_key, payload")
      .eq("trading_day_id", day.id);
    const transporterRows = outboxRows?.filter((row) => row.recipient_type === "transporter") ?? [];
    expect(transporterRows).toHaveLength(1);
    expect(transporterRows[0]).toMatchObject({
      recipient_company_id: transporter.id,
      template_key: "close_arrangement_grower_transporter",
    });
    const [growerRow] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, grower.companyId));
    expect((transporterRows[0]!.payload as { companyName?: string }).companyName).toBe(growerRow!.name);
  }, 30000);

  it("set_pick_closed (migration 0081): completing a grower sends its and its transporter's messages at once, and closing the day does not send them again", async () => {
    const { day, grower, customer, pickProductId, orderProductId } =
      await setUpDayWithSupplyAndDemand(5, 5);
    const transporter = await assignTransporter(grower.companyId);
    const created = await admin.client.rpc(
      "create_arrangement_record",
      toCreateArrangementRecordRpcArgs({
        dailyPickProductId: pickProductId,
        dailyOrderProductId: orderProductId,
        quantityPallets: 5,
      }),
    );
    expect(created.error).toBeNull();
    await db
      .update(dailyOrders)
      .set({ status: "submitted" })
      .where(and(eq(dailyOrders.tradingDayId, day.id), eq(dailyOrders.customerCompanyId, customer.id)));
    const [line] = await db.select({ pickId: dailyPickProducts.dailyPickId }).from(dailyPickProducts).where(eq(dailyPickProducts.id, pickProductId));

    const sales = async () =>
      ((await admin.client.from("notification_outbox").select("recipient_type, recipient_company_id, template_key").eq("trading_day_id", day.id)).data ?? [])
        .filter((row) => row.template_key.startsWith("close_arrangement_grower"));

    const completed = await admin.client.rpc("set_pick_closed", { p_daily_pick_id: line!.pickId, p_closed: true });
    expect(completed.error).toBeNull();
    expect(completed.data?.completion_messaged_at).toBeTruthy();
    expect((await sales()).map((row) => row.recipient_company_id).sort()).toEqual([grower.companyId, transporter.id].sort());

    expect((await admin.client.rpc("close_shop")).error).toBeNull();
    expect((await admin.client.rpc("close_arrangement")).error).toBeNull();
    expect(await sales()).toHaveLength(2);
  }, 30000);

  // Migration 0089: a closed pick (the truck icon) blocks arranging until it
  // is reopened.
  it("a closed pick refuses arranging from it (migration 0089), and reopening it lets arranging go on", async () => {
    const { pickProductId, customer } = await setUpDayWithSupplyAndDemand(5, 5);
    const [line] = await db.select({ pickId: dailyPickProducts.dailyPickId }).from(dailyPickProducts).where(eq(dailyPickProducts.id, pickProductId));
    const arrange = () =>
      admin.client.rpc("arrange_to_customer", {
        p_daily_pick_product_id: pickProductId,
        p_customer_company_id: customer.id,
        p_quantity_pallets: 1,
      });

    expect((await admin.client.rpc("set_pick_closed", { p_daily_pick_id: line!.pickId, p_closed: true })).error).toBeNull();
    const refused = await arrange();
    expect(refused.error?.code).toBe(ARRANGEMENT_ERROR_CODES.PICK_CLOSED);
    expect(await recordsOn(pickProductId)).toEqual([]);

    expect((await admin.client.rpc("set_pick_closed", { p_daily_pick_id: line!.pickId, p_closed: false })).error).toBeNull();
    expect((await arrange()).error).toBeNull();
    expect(await recordsOn(pickProductId)).toHaveLength(1);
  }, 30000);
});
