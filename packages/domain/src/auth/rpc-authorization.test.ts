import { randomUUID } from "node:crypto";

import { db } from "@ori/db";
import {
  alerts,
  dailyOrderProducts,
  dailyOrders,
  dailyPickProducts,
  dailyPicks,
  notificationOutbox,
  orderSubmissionLogs,
} from "@ori/db/schema";
import type { Database } from "@ori/db/supabase-types";
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
import { toOrderableCatalogRpcArgs, toSubmitOrderRpcArgs } from "@ori/domain/customer";
import { createTestDailyOrder, createTestDailyShop } from "@ori/domain/customer/testing";
import {
  toSavePickLinesRpcArgs,
  toSetPickPickupTimeRpcArgs,
  toUpdatePickProductDetailsRpcArgs,
} from "@ori/domain/grower";
import {
  toRevertPickToDraftRpcArgs,
  toSubmitPickRpcArgs,
  toUpdatePickProductPalletsRpcArgs,
} from "@ori/domain/lifecycle-engine";
import {
  createTestGrowerWithProduct,
  createTestOrderProductLine,
  createTestTradingDay,
  deleteTestGrowerWithProduct,
  deleteTestTradingDay,
} from "@ori/domain/lifecycle-engine/testing";
import { toCreateAlertRpcArgs } from "@ori/domain/notifications";
import { createTestAlertType, deleteTestAlertType } from "@ori/domain/notifications/testing";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Migration 0076 (release workbook task 02, ORI-001). Eight functions run as
// SECURITY DEFINER — past every row-level security rule — and check the caller
// themselves. Those checks compared public.current_role() with `<>`, which is
// never true for NULL, and current_role() is NULL for a signed-in account with
// no profile and for a visitor who is not signed in at all. So both could
// change picks, send orders on any customer's behalf and create alerts, given
// a record's id. This file calls every one of those functions with input that
// is VALID for the person allowed to use it, as everyone who is not, and reads
// the affected rows back over the trusted connection (`db`, which no security
// rule filters) to prove nothing changed. Then it checks the right people can
// still do their job.
//
// Like every file here it opens its own trading day (phase shop_open), so it
// relies on the suite's one-file-at-a-time run (vitest.config.ts) and on the
// global setup borrowing the single open-day slot.
describe("privileged functions refuse callers without a profile or a sign-in (0076)", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  type Client = SupabaseClient<Database>;
  let admin: { client: Client; userId: string };
  let growerA: { client: Client; companyId: string; varietyId: string };
  let growerB: { client: Client; companyId: string };
  let customer1: { client: Client; userId: string; companyId: string };
  let customer2: { client: Client; companyId: string };
  let noProfile: Client;
  let anon: Client;
  let alertTypeId: string;
  let dayId: string;
  let pickA: { id: string; lineId: string };
  let pickB: { id: string };

  // A signed-in account the way a half-finished invitation leaves one: an Auth
  // user with no profiles row, so current_role() is NULL for it. Same shape as
  // arrangement.test.ts's signedInWithoutProfile.
  async function signedInWithoutProfile(): Promise<Client> {
    const email = `test-${randomUUID()}@example.test`;
    const password = `Correct-Horse-${randomUUID()}`;
    const created = await createServiceRoleClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error).toBeNull();
    cleanupFns.push(() => deleteTestUser(created.data.user!.id));
    return signInTestUser(email, password);
  }

  async function signedIn(companyId: string, role: "backoffice" | "grower" | "customer") {
    const profile = await createTestProfile({ companyId, role });
    cleanupFns.push(() => deleteTestUser(profile.userId));
    return {
      client: await signInTestUser(profile.email, profile.password),
      userId: profile.userId,
    };
  }

  beforeAll(async () => {
    const adminCompany = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(adminCompany.id));
    admin = await signedIn(adminCompany.id, "backoffice");

    const growerAFixture = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(growerAFixture));
    growerA = {
      client: (await signedIn(growerAFixture.companyId, "grower")).client,
      companyId: growerAFixture.companyId,
      varietyId: growerAFixture.varietyId,
    };
    const growerBFixture = await createTestGrowerWithProduct();
    cleanupFns.push(() => deleteTestGrowerWithProduct(growerBFixture));
    growerB = {
      client: (await signedIn(growerBFixture.companyId, "grower")).client,
      companyId: growerBFixture.companyId,
    };

    const customer1Company = await createTestCompany(`לקוח בדיקה ${randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(customer1Company.id));
    customer1 = {
      ...(await signedIn(customer1Company.id, "customer")),
      companyId: customer1Company.id,
    };
    const customer2Company = await createTestCompany(`לקוח בדיקה ${randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(customer2Company.id));
    customer2 = {
      client: (await signedIn(customer2Company.id, "customer")).client,
      companyId: customer2Company.id,
    };

    noProfile = await signedInWithoutProfile();
    anon = createAnonClient();

    const alertType = await createTestAlertType();
    cleanupFns.push(() => deleteTestAlertType(alertType.id));
    alertTypeId = alertType.id;
    // Alerts cascade away with their user, but the alert type above is deleted
    // before the users are (LIFO), so any alert a control creates goes first.
    cleanupFns.push(async () => {
      await db.delete(alerts).where(eq(alerts.alertTypeId, alertType.id));
    });

    // The day, pushed last so it is torn down first: it cascades to every
    // pick, order, submission log and outbox row below, which all reference
    // the companies and users above.
    const day = await createTestTradingDay({ initiatedByUserId: admin.userId, phase: "shop_open" });
    cleanupFns.push(() => deleteTestTradingDay(day.id));
    dayId = day.id;
    await createTestDailyShop({ tradingDayId: day.id, openedByUserId: admin.userId });

    // Grower A's pick is a draft (what save/submit act on); grower B's was
    // already sent (what revert_pick_to_draft acts on).
    const [a] = await db
      .insert(dailyPicks)
      .values({ tradingDayId: day.id, growerCompanyId: growerA.companyId })
      .returning();
    const [aLine] = await db
      .insert(dailyPickProducts)
      .values({ dailyPickId: a!.id, productVarietyId: growerA.varietyId, palletsPicked: "5" })
      .returning();
    pickA = { id: a!.id, lineId: aLine!.id };
    const [b] = await db
      .insert(dailyPicks)
      .values({
        tradingDayId: day.id,
        growerCompanyId: growerB.companyId,
        status: "submitted",
        submittedAt: new Date(),
      })
      .returning();
    pickB = { id: b!.id };

    await createTestOrderProductLine(day.id, customer1.companyId, growerA.varietyId, 2);
    await createTestDailyOrder({ tradingDayId: day.id, customerCompanyId: customer2.companyId });
  }, 120000);

  afterAll(async () => {
    await runCleanup(cleanupFns);
  }, 120000);

  // Everything these functions can write for this file's fixtures, read over
  // the trusted connection — an independent readback that no security rule
  // can hide a change from.
  async function protectedRows() {
    const picks = await db.select().from(dailyPicks).where(eq(dailyPicks.tradingDayId, dayId));
    const pickIds = picks.map((p) => p.id);
    const orders = await db.select().from(dailyOrders).where(eq(dailyOrders.tradingDayId, dayId));
    const orderIds = orders.map((o) => o.id);
    const byId = (x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id);
    return JSON.stringify({
      picks: picks.sort(byId),
      pickLines: (
        await db
          .select()
          .from(dailyPickProducts)
          .where(inArray(dailyPickProducts.dailyPickId, pickIds))
      ).sort(byId),
      orders: orders.sort(byId),
      orderLines: (
        await db
          .select()
          .from(dailyOrderProducts)
          .where(inArray(dailyOrderProducts.dailyOrderId, orderIds))
      ).sort(byId),
      submissionLogs: (
        await db
          .select()
          .from(orderSubmissionLogs)
          .where(inArray(orderSubmissionLogs.dailyOrderId, orderIds))
      ).sort(byId),
      // create_alert's alerts carry this file's alert type; build_arrangement_alerts'
      // carry the day as their display record.
      alerts: (
        await db
          .select()
          .from(alerts)
          .where(or(eq(alerts.alertTypeId, alertTypeId), eq(alerts.displayRecordId, dayId)))
      ).sort(byId),
      outbox: (
        await db.select().from(notificationOutbox).where(eq(notificationOutbox.tradingDayId, dayId))
      ).sort(byId),
    });
  }

  type Call = (client: Client) => PromiseLike<{ error: PostgrestError | null }>;

  // Each outsider must be refused with 42501 and leave every protected row as
  // it was. A visitor who is not signed in must be stopped by the missing
  // EXECUTE grant ("permission denied"), before the function runs at all.
  async function expectRefused(fn: string, call: Call, outsiders: Array<[string, Client]>) {
    for (const [who, client] of outsiders) {
      const before = await protectedRows();
      const { error } = await call(client);
      expect(error?.code, `${fn} as ${who}`).toBe("42501");
      if (client === anon) expect(error?.message, `${fn} as ${who}`).toMatch(/permission denied/);
      expect(await protectedRows(), `${fn} as ${who} must change nothing`).toBe(before);
    }
  }

  const everyoneButStaffAndOwner = (): Array<[string, Client]> => [
    ["a visitor who is not signed in", anon],
    ["a signed-in account with no profile", noProfile],
    ["another grower", growerB.client],
    ["a customer", customer1.client],
  ];

  it("the grower pick functions refuse everyone but the pick's own grower and backoffice", async () => {
    await expectRefused(
      "save_pick_lines",
      (c) =>
        c.rpc(
          "save_pick_lines",
          toSavePickLinesRpcArgs({
            dailyPickId: pickA.id,
            lines: [
              {
                dailyPickProductId: pickA.lineId,
                palletsPicked: 6,
                leftoverPallets: 0,
                comment: null,
              },
            ],
          }),
        ),
      everyoneButStaffAndOwner(),
    );
    await expectRefused(
      "update_pick_product_pallets",
      (c) =>
        c.rpc(
          "update_pick_product_pallets",
          toUpdatePickProductPalletsRpcArgs({ dailyPickProductId: pickA.lineId, palletsPicked: 6 }),
        ),
      everyoneButStaffAndOwner(),
    );
    await expectRefused(
      "update_pick_product_details",
      (c) =>
        c.rpc(
          "update_pick_product_details",
          toUpdatePickProductDetailsRpcArgs({ dailyPickProductId: pickA.lineId, comment: "x" }),
        ),
      everyoneButStaffAndOwner(),
    );
    await expectRefused(
      "submit_pick",
      (c) => c.rpc("submit_pick", toSubmitPickRpcArgs({ dailyPickId: pickA.id })),
      everyoneButStaffAndOwner(),
    );
    await expectRefused(
      "set_pick_pickup_time",
      (c) =>
        c.rpc(
          "set_pick_pickup_time",
          toSetPickPickupTimeRpcArgs({ dailyPickId: pickA.id, pickupTime: "06:30" }),
        ),
      everyoneButStaffAndOwner(),
    );
  }, 60000);

  it("revert_pick_to_draft, create_alert and build_arrangement_alerts refuse everyone but backoffice", async () => {
    const outsiders = (): Array<[string, Client]> => [
      ["a visitor who is not signed in", anon],
      ["a signed-in account with no profile", noProfile],
      ["the pick's own grower", growerB.client],
      ["a customer", customer1.client],
    ];
    await expectRefused(
      "revert_pick_to_draft",
      (c) => c.rpc("revert_pick_to_draft", toRevertPickToDraftRpcArgs({ dailyPickId: pickB.id })),
      outsiders(),
    );
    await expectRefused(
      "create_alert",
      (c) =>
        c.rpc(
          "create_alert",
          toCreateAlertRpcArgs({ intendedForUserId: customer1.userId, alertTypeId }),
        ),
      outsiders(),
    );
    await expectRefused(
      "build_arrangement_alerts",
      (c) => c.rpc("build_arrangement_alerts", { p_trading_day_id: dayId }),
      outsiders(),
    );
  }, 60000);

  it("send_order_reminder with a list refuses everyone but backoffice and queues nothing (0104)", async () => {
    const [order] = await db
      .select()
      .from(dailyOrders)
      .where(inArray(dailyOrders.customerCompanyId, [customer2.companyId]));
    await expectRefused(
      "send_order_reminder",
      (c) =>
        c.rpc("send_order_reminder", {
          p_daily_order_id: order!.id,
          p_recipient_user_ids: [customer1.userId],
        }),
      everyoneButStaffAndOwner(),
    );
    // expectRefused already proves the day's outbox rows are unchanged; this
    // says it plainly for the one company a reminder would have gone to.
    expect(
      await db.select().from(notificationOutbox).where(eq(notificationOutbox.recipientCompanyId, customer2.companyId)),
    ).toHaveLength(0);
  }, 60000);

  it("submit_order refuses an order on another company's behalf from anyone but backoffice, and an own-order send from anyone but a customer", async () => {
    const lines = [{ productVarietyId: growerA.varietyId, palletsOrdered: 1 }];
    await expectRefused(
      "submit_order on customer 1's behalf",
      (c) =>
        c.rpc(
          "submit_order",
          toSubmitOrderRpcArgs({
            tradingDayId: dayId,
            lines,
            customerCompanyId: customer1.companyId,
          }),
        ),
      [
        ["a visitor who is not signed in", anon],
        ["a signed-in account with no profile", noProfile],
        ["a grower", growerA.client],
        ["another customer", customer2.client],
      ],
    );
    await expectRefused(
      "submit_order as an own order",
      (c) => c.rpc("submit_order", toSubmitOrderRpcArgs({ tradingDayId: dayId, lines })),
      [
        ["a visitor who is not signed in", anon],
        ["a signed-in account with no profile", noProfile],
        ["a grower", growerA.client],
      ],
    );
  }, 60000);

  it("the two internal stock helpers cannot be called through the API at all — not even by backoffice", async () => {
    const everyone: Array<[string, Client]> = [
      ["a visitor who is not signed in", anon],
      ["a signed-in account with no profile", noProfile],
      ["a customer", customer1.client],
      ["backoffice", admin.client],
    ];
    await expectRefused(
      "max_orderable_for_customer",
      (c) =>
        c.rpc("max_orderable_for_customer", {
          p_trading_day_id: dayId,
          p_product_variety_id: growerA.varietyId,
          p_customer_company_id: customer1.companyId,
        }),
      everyone,
    );
    await expectRefused(
      "shop_variety_orderability",
      (c) => c.rpc("shop_variety_orderability", { p_trading_day_id: dayId }),
      everyone,
    );
  }, 60000);

  // Runs after the refusals above, in this order, because each step builds on
  // the one before (the pick is saved, sent, then reopened).
  it("the right people still get through: the owning grower, a customer for their own order, and backoffice", async () => {
    const pickLine = async () =>
      (await db.select().from(dailyPickProducts).where(eq(dailyPickProducts.id, pickA.lineId)))[0]!;
    const pick = async () =>
      (await db.select().from(dailyPicks).where(eq(dailyPicks.id, pickA.id)))[0]!;

    const saved = await growerA.client.rpc(
      "save_pick_lines",
      toSavePickLinesRpcArgs({
        dailyPickId: pickA.id,
        lines: [
          { dailyPickProductId: pickA.lineId, palletsPicked: 6, leftoverPallets: 0, comment: null },
        ],
      }),
    );
    expect(saved.error).toBeNull();
    expect(Number((await pickLine()).palletsPicked)).toBe(6);

    const commented = await growerA.client.rpc(
      "update_pick_product_details",
      toUpdatePickProductDetailsRpcArgs({ dailyPickProductId: pickA.lineId, comment: "נבדק" }),
    );
    expect(commented.error).toBeNull();
    expect((await pickLine()).comment).toBe("נבדק");

    const staffEdit = await admin.client.rpc(
      "update_pick_product_pallets",
      toUpdatePickProductPalletsRpcArgs({ dailyPickProductId: pickA.lineId, palletsPicked: 7 }),
    );
    expect(staffEdit.error).toBeNull();
    expect(Number((await pickLine()).palletsPicked)).toBe(7);

    const sent = await growerA.client.rpc(
      "submit_pick",
      toSubmitPickRpcArgs({ dailyPickId: pickA.id }),
    );
    expect(sent.error).toBeNull();
    expect((await pick()).status).toBe("submitted");

    // The owning grower can set the day's pickup time (0105), even after sending.
    const timed = await growerA.client.rpc(
      "set_pick_pickup_time",
      toSetPickPickupTimeRpcArgs({ dailyPickId: pickA.id, pickupTime: "06:30" }),
    );
    expect(timed.error).toBeNull();
    expect((await pick()).pickupTime).toBe("06:30:00");

    const reopened = await admin.client.rpc(
      "revert_pick_to_draft",
      toRevertPickToDraftRpcArgs({ dailyPickId: pickA.id }),
    );
    expect(reopened.error).toBeNull();
    expect((await pick()).status).toBe("draft");

    // The catalog and a customer's own send both use the two helpers inside
    // them — still working proves revoking direct access left them alone.
    const catalog = await customer1.client.rpc(
      "get_orderable_catalog_for_customer",
      toOrderableCatalogRpcArgs({ tradingDayId: dayId }),
    );
    expect(catalog.error).toBeNull();
    expect(catalog.data!.find((row) => row.variety_id === growerA.varietyId)).toBeDefined();

    const ownOrder = await customer1.client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: dayId,
        lines: [{ productVarietyId: growerA.varietyId, palletsOrdered: 3 }],
      }),
    );
    expect(ownOrder.error).toBeNull();

    const onBehalf = await admin.client.rpc(
      "submit_order",
      toSubmitOrderRpcArgs({
        tradingDayId: dayId,
        lines: [{ productVarietyId: growerA.varietyId, palletsOrdered: 1 }],
        customerCompanyId: customer2.companyId,
      }),
    );
    expect(onBehalf.error).toBeNull();

    const alert = await admin.client.rpc(
      "create_alert",
      toCreateAlertRpcArgs({ intendedForUserId: customer1.userId, alertTypeId }),
    );
    expect(alert.error).toBeNull();

    const built = await admin.client.rpc("build_arrangement_alerts", { p_trading_day_id: dayId });
    expect(built.error).toBeNull();
  }, 60000);
});
