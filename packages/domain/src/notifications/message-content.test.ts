import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { db } from "@ori/db";
import {
  companies,
  dailyArrangements,
  dailyOrderProducts,
  dailyOrders,
  dailyPickProducts,
  dailyPicks,
  notificationOutbox,
  notificationTemplates,
  productFamilies,
  productVarieties,
  profiles,
} from "@ori/db/schema";
import type { Database } from "@ori/db/supabase-types";
import {
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
  signInTestUser,
} from "@ori/domain/auth/testing";
import { toSetPickPickupTimeRpcArgs } from "@ori/domain/grower";
import {
  createTestArrangementRecord,
  createTestGrowerWithProduct,
  createTestOrderProductLine,
  createTestTradingDay,
  deleteTestGrowerWithProduct,
  deleteTestTradingDay,
} from "@ori/domain/lifecycle-engine/testing";
import { normalizePhoneNumber } from "@ori/shared/phone";
import type { SupabaseClient } from "@supabase/supabase-js";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestOutboxRow } from "./test-helpers";
import { toWhatsAppNumber } from "./whatsapp-channel";

// Migration 0077 (release workbook task 15 — ORI-017, ORI-018):
//   - office messages name the company or product they are about (0053 had
//     dropped those values, so they went out blank);
//   - phone numbers are kept in one form — Israeli as 0501234567, foreign as
//     +<country code><number> (James, 2026-11-09) — every
//     save goes through the rule, and the queued dispatch addresses a person
//     the same way the password-reset sender does.
// The messages use the REAL templates seeded by the migrations, not test
// templates, so a template edit that loses a placeholder shows up here.
describe("message content and phone numbers (0077)", () => {
  type Client = SupabaseClient<Database>;
  const cleanupFns: Array<() => Promise<void>> = [];
  const fileCleanupFns: Array<() => Promise<void>> = [];
  let admin: Client;
  let dayId: string;

  beforeAll(async () => {
    const office = await createTestCompany();
    fileCleanupFns.push(() => deleteTestCompany(office.id));
    const bo = await createTestProfile({ companyId: office.id, role: "backoffice" });
    fileCleanupFns.push(() => deleteTestUser(bo.userId));
    admin = await signInTestUser(bo.email, bo.password);
    const day = await createTestTradingDay({ initiatedByUserId: bo.userId, phase: "closed" });
    fileCleanupFns.push(() => deleteTestTradingDay(day.id));
    dayId = day.id;
  });

  afterAll(async () => {
    await runCleanup(fileCleanupFns);
  });

  afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  // An office company to address: by WhatsApp group, or person by person.
  async function officeRecipient(how: "group" | "people") {
    const company = await createTestCompany(`משרד בדיקה ${randomUUID()}`, "backoffice");
    cleanupFns.push(() => deleteTestCompany(company.id));
    if (how === "group") {
      await db.update(companies).set({ whatsappGroupId: `grp-${randomUUID()}` }).where(eq(companies.id, company.id));
    } else {
      const person = await createTestProfile({ companyId: company.id, role: "backoffice", displayName: "רונית לוי", phoneNumber: "052-765 4321" });
      cleanupFns.push(() => deleteTestUser(person.userId));
    }
    return company.id;
  }

  async function queued(templateKey: string, companyId: string, payload: Record<string, unknown>) {
    const row = await createTestOutboxRow({
      tradingDayId: dayId,
      recipientType: "backoffice",
      recipientCompanyId: companyId,
      templateKey,
      payload: { tradeDate: "2026-11-08", lines: [], ...payload },
    });
    cleanupFns.push(async () => {
      await db.delete(notificationOutbox).where(eq(notificationOutbox.id, row.id));
    });
    return row.id;
  }

  it.each([
    ["order_submitted", { companyName: "שוק הבדיקה" }, ["שוק הבדיקה שלחו הזמנה"]],
    ["stock_overbooking_reached", { productName: "בננה גדולה", productOverbooking: "3" }, ["עבור בננה גדולה הוזמנו", "לעוד 3 משטחים"]],
    ["stock_fully_exhausted", { productName: "בננה קטנה" }, ["עבור בננה קטנה הוזמנו"]],
  ] as const)("%s names what it is about — to a group, to each person, and in the dev preview", async (templateKey, payload, expected) => {
    for (const how of ["group", "people"] as const) {
      const id = await queued(templateKey, await officeRecipient(how), payload);
      const resolved = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: id });
      expect(resolved.error).toBeNull();
      expect(resolved.data).toHaveLength(1);
      const message = resolved.data![0]!.message;
      for (const text of expected) expect(message, `${how}: ${message}`).toContain(text);
      expect(message).not.toMatch(/%[A-Z_]+%/);
      if (how === "people") {
        expect(resolved.data![0]).toMatchObject({ target: "972527654321", is_group: false });
        // Each person by their first name, the Bubble way ("שלום רונית.").
        expect(message.startsWith("שלום רונית."), message).toBe(true);
      }
      const preview = await admin.rpc("resolve_outbox_preview", { p_outbox_id: id });
      expect(preview.error).toBeNull();
      for (const text of expected) expect(preview.data).toContain(text);
    }
  }, 60000);

  // 0106: Bubble posts "the grower updated the pick estimate" in that grower's
  // own group only (0102 wording: main alert 3, the day as "<letter> dd.mm.yy").
  it("pick_updated names the grower — to the grower's group only", async () => {
    const text = "שלום. משק הבדיקה עדכן את הערכת הקטיף ליום ר 08.11.26 ";
    const grower = await createTestCompany(`משק בדיקה ${randomUUID()}`, "grower");
    cleanupFns.push(() => deleteTestCompany(grower.id));
    await db.update(companies).set({ whatsappGroupId: `grp-${randomUUID()}` }).where(eq(companies.id, grower.id));
    const person = await createTestProfile({ companyId: grower.id, role: "grower", displayName: "דנה כהן", phoneNumber: "052-765 4321" });
    cleanupFns.push(() => deleteTestUser(person.userId));

    const row = await createTestOutboxRow({
      tradingDayId: dayId,
      recipientType: "grower",
      recipientCompanyId: grower.id,
      templateKey: "pick_updated",
      payload: { tradeDate: "2026-11-08", lines: [], companyName: "משק הבדיקה" },
    });
    cleanupFns.push(async () => {
      await db.delete(notificationOutbox).where(eq(notificationOutbox.id, row.id));
    });
    const grouped = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: row.id });
    expect(grouped.error).toBeNull();
    expect(grouped.data).toHaveLength(1);
    expect(grouped.data![0]).toMatchObject({ is_group: true });
    expect(grouped.data![0]!.message).toContain(text);
    const preview = await admin.rpc("resolve_outbox_preview", { p_outbox_id: row.id });
    expect(preview.error).toBeNull();
    expect(preview.data).toContain(text);

    // A grower without a group is not messaged person by person.
    await db.update(companies).set({ whatsappGroupId: null }).where(eq(companies.id, grower.id));
    const none = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: row.id });
    expect(none.error).toBeNull();
    expect(none.data).toEqual([]);
  }, 60000);

  it("the SQL phone rule agrees with packages/shared/src/phone-cases.json, and so does the password-reset sender", async () => {
    const { cases } = JSON.parse(
      readFileSync(new URL("../../../shared/src/phone-cases.json", import.meta.url), "utf8"),
    ) as { cases: Array<{ input: string | null; local: string | null }> };
    const inputs = cases.map((c) => c.input);
    const result = await db.execute<{ i: number; local: string | null; wa: string | null }>(sql`
      select i::int, public.normalize_phone_number(input) as local, public.whatsapp_personal_number(input) as wa
      from unnest(${sql.raw(`array[${inputs.map((x) => (x === null ? "null" : `'${x.replace(/'/g, "''")}'`)).join(",")}]::text[]`)}) with ordinality as t(input, i)
    `);
    const rows = [...result].sort((a, b) => a.i - b.i);
    expect(rows).toHaveLength(cases.length);
    cases.forEach((c, index) => {
      expect(rows[index]!.local, JSON.stringify(c.input)).toBe(c.local);
      expect(normalizePhoneNumber(c.input)).toBe(c.local);
      expect(rows[index]!.wa).toBe(toWhatsAppNumber(c.input));
    });
  }, 30000);

  it("saving a phone number: tidied, a foreign one kept with its country code, refused in Hebrew when it is not a number, and an old invalid number does not block other fields", async () => {
    const company = await createTestCompany(`לקוח בדיקה ${randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(company.id));
    const user = await createTestProfile({ companyId: company.id, role: "customer" });
    cleanupFns.push(() => deleteTestUser(user.userId));
    const client = await signInTestUser(user.email, user.password);
    const stored = async () => (await db.select({ p: profiles.phoneNumber }).from(profiles).where(eq(profiles.userId, user.userId)))[0]!.p;

    expect((await client.from("profiles").update({ phone_number: "+972 50-765 4321" }).eq("user_id", user.userId)).error).toBeNull();
    expect(await stored()).toBe("0507654321");

    expect((await client.from("profiles").update({ phone_number: "+970 59 123 4567" }).eq("user_id", user.userId)).error).toBeNull();
    expect(await stored()).toBe("+970591234567");

    const refused = await client.from("profiles").update({ phone_number: "12" }).eq("user_id", user.userId);
    expect(refused.error?.code).toBe("22023");
    expect(refused.error?.message).toContain("מספר הטלפון אינו תקין");
    expect(await stored()).toBe("+970591234567");

    // An old value saved before 0077 that is not a number at all.
    await db.transaction(async (tx) => {
      await tx.execute(sql`alter table public.profiles disable trigger profiles_tidy_phone_number`);
      await tx.update(profiles).set({ phoneNumber: "not a phone" }).where(eq(profiles.userId, user.userId));
      await tx.execute(sql`alter table public.profiles enable trigger profiles_tidy_phone_number`);
    });
    const otherField = await admin.from("profiles").update({ display_name: "שם חדש", phone_number: "not a phone" }).eq("user_id", user.userId);
    expect(otherField.error).toBeNull();
    const changed = await admin.from("profiles").update({ phone_number: "still not a phone" }).eq("user_id", user.userId);
    expect(changed.error?.code).toBe("22023");

    expect((await client.from("profiles").update({ phone_number: "" }).eq("user_id", user.userId)).error).toBeNull();
    expect(await stored()).toBeNull();
  }, 30000);

  it("the dispatch reaches an old untidied number and a foreign one, and skips one that is not a number", async () => {
    const company = await createTestCompany(`משרד בדיקה ${randomUUID()}`, "backoffice");
    cleanupFns.push(() => deleteTestCompany(company.id));
    const messy = await createTestProfile({ companyId: company.id, role: "backoffice", displayName: "אבי" });
    cleanupFns.push(() => deleteTestUser(messy.userId));
    const foreign = await createTestProfile({ companyId: company.id, role: "backoffice", displayName: "בני" });
    cleanupFns.push(() => deleteTestUser(foreign.userId));
    const broken = await createTestProfile({ companyId: company.id, role: "backoffice", displayName: "גדי" });
    cleanupFns.push(() => deleteTestUser(broken.userId));
    // Values saved before 0077, written past the check.
    await db.transaction(async (tx) => {
      await tx.execute(sql`alter table public.profiles disable trigger profiles_tidy_phone_number`);
      await tx.update(profiles).set({ phoneNumber: "050-123 4567" }).where(eq(profiles.userId, messy.userId));
      await tx.update(profiles).set({ phoneNumber: "+970 59-123-4567" }).where(eq(profiles.userId, foreign.userId));
      await tx.update(profiles).set({ phoneNumber: "12" }).where(eq(profiles.userId, broken.userId));
      await tx.execute(sql`alter table public.profiles enable trigger profiles_tidy_phone_number`);
    });
    const id = await queued("order_reminder", company.id, {});
    const resolved = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: id });
    expect(resolved.error).toBeNull();
    expect(resolved.data!.map((t) => t.target).sort()).toEqual(["970591234567", "972501234567"]);
  }, 30000);

  // Migration 0104: the office picks which of a customer's people get the
  // reminder. A list means exactly those people, privately — the group is
  // never used, even when the company has one.
  async function customerWithPeople() {
    const company = await createTestCompany(`לקוח בדיקה ${randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(company.id));
    await db.update(companies).set({ whatsappGroupId: `grp-${randomUUID()}` }).where(eq(companies.id, company.id));
    const a = await createTestProfile({ companyId: company.id, role: "customer", displayName: "אילנה כהן", phoneNumber: "050-111 1111" });
    cleanupFns.push(() => deleteTestUser(a.userId));
    const b = await createTestProfile({ companyId: company.id, role: "customer", displayName: "בועז לוי", phoneNumber: "052-765 4321" });
    cleanupFns.push(() => deleteTestUser(b.userId));
    const c = await createTestProfile({ companyId: company.id, role: "customer", displayName: "גילה דן" });
    cleanupFns.push(() => deleteTestUser(c.userId));
    return { company, a, b, c };
  }

  async function queuedFor(companyId: string, recipientUserIds: string[]) {
    const row = await createTestOutboxRow({
      tradingDayId: dayId,
      recipientType: "customer",
      recipientCompanyId: companyId,
      templateKey: "order_reminder",
      payload: { tradeDate: "2026-11-08", lines: [] },
      recipientUserIds,
    });
    cleanupFns.push(async () => {
      await db.delete(notificationOutbox).where(eq(notificationOutbox.id, row.id));
    });
    return row.id;
  }

  it("a reminder with a list goes to exactly those people, privately, never the group", async () => {
    const { company, b, c } = await customerWithPeople();
    const id = await queuedFor(company.id, [b.userId, c.userId]);
    const resolved = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: id });
    expect(resolved.error).toBeNull();
    // C has no phone number, A is not on the list, the group is not used.
    expect(resolved.data).toHaveLength(1);
    expect(resolved.data![0]).toMatchObject({ target: "972527654321", is_group: false });
    expect(resolved.data![0]!.message.startsWith("שלום בועז.")).toBe(true);
  }, 30000);

  it("skips a listed user who moved company", async () => {
    const { company, a } = await customerWithPeople();
    const other = await createTestCompany(`לקוח אחר ${randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(other.id));
    const id = await queuedFor(company.id, [a.userId]);
    await db.update(profiles).set({ companyId: other.id }).where(eq(profiles.userId, a.userId));
    const resolved = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: id });
    // Put A back before checking, so the other company can be deleted.
    await db.update(profiles).set({ companyId: company.id }).where(eq(profiles.userId, a.userId));
    expect(resolved.error).toBeNull();
    expect(resolved.data).toHaveLength(0);
  }, 30000);

  // ---------------------------------------------------------------------
  // Migration 0102 (James, 2026-11-13): every WhatsApp message is Bubble's —
  // its `main alert` text word for word, its details filled in the way
  // Bubble's live workflows fill them, and a link to the recipient's own
  // screen in Ori. Two of Bubble's glitches are fixed: half pallets are
  // written as they are (Bubble rounds them in the grower's and the
  // transporter's lists), and "הודעה זו נשלחה גם למוביל" is written only when
  // the grower has a transporter. Who receives each message is unchanged.
  const ORI = "https://ori-claude-web.vercel.app";
  const BUBBLE: Record<string, { text: string; link: string | null }> = {
    business_day_open_grower: { text: "שלום %FIRST_NAME%. אנא עדכנו הערכת קטיף ליום %CURRENT_OPEN_BUSINESS_DAY% ", link: `${ORI}/grower/picks` }, // main alert 1
    pick_reminder: { text: "שלום %FIRST_NAME%. אנא עדכנו הערכת קטיף ליום %CURRENT_OPEN_BUSINESS_DAY% ", link: `${ORI}/grower/picks` }, // 2
    pick_updated: { text: "שלום. %COMPANY% עדכן את הערכת הקטיף ליום %CURRENT_OPEN_BUSINESS_DAY% ", link: `${ORI}/backoffice/distributor-grower` }, // 3
    shop_open: { text: "שלום %FIRST_NAME%. החנות כעת פתוחה להזמנות.", link: `${ORI}/customer/order` }, // 4
    order_reminder: { text: "שלום %FIRST_NAME%. זוהי תזכורת לשלוח הזמנה ליום %CURRENT_OPEN_BUSINESS_DAY% ", link: `${ORI}/customer/order` }, // 5
    order_submitted: {
      text: "שלום %FIRST_NAME%. \n%COMPANY% שלחו הזמנה על ידי %COMPANY_USER_FULL_NAME%.\nלהלן מצב ההזמנה הנוכחי שלהם:\n\n%ORDER_DETAILS%",
      link: `${ORI}/backoffice/distributor-customer`,
    }, // 6
    close_arrangement_grower_transporter: {
      text: "היי, %NL%\nלהלן הסידור של %COMPANY% לתאריך %CURRENT_OPEN_BUSINESS_DAY%.  %NL%\n%ORDER_DETAILS% %NL%\nהמשטחים יהיו מוכנים לאיסוף ב %PICKUP_TIME%",
      link: null,
    }, // 7
    close_arrangement_grower: {
      text: "היי, %NL%\nלהלן הסידור של %COMPANY% לתאריך %CURRENT_OPEN_BUSINESS_DAY%. %NL%\n%ORDER_DETAILS% %NL%\nהודעה זו נשלחה גם למוביל",
      link: null,
    }, // 8
    close_arrangement_customer: {
      text: "שלום %FIRST_NAME%. להלן המוצרים שהזמנת ושתקבל לתאריך %CURRENT_OPEN_BUSINESS_DAY% מהמגדלים השונים: %NL%%ORDER_DETAILS%",
      link: `${ORI}/customer/history`,
    }, // 9
    stock_overbooking_reached: {
      text: "שלום %FIRST_NAME%. כל המשטחים שנקטפו עבור %PRODUCT_NAME% הוזמנו. האפשרות להזמין תשאר פתוחה לעוד %PRODUCT_OVERBOOKING% משטחים עבור מוצר זה.",
      link: null,
    }, // 10
    stock_fully_exhausted: {
      text: "שלום %FIRST_NAME%. כל המשטחים + אוברבוקינג עבור %PRODUCT_NAME% הוזמנו. לא ניתן יותר להזמין ממוצר זה במערכת.",
      link: null,
    }, // 11
  };

  it("every template is Bubble's main alert text, word for word, with a link to the recipient's own screen in Ori", async () => {
    const rows = await db
      .select({ key: notificationTemplates.templateKey, text: notificationTemplates.content, link: notificationTemplates.link })
      .from(notificationTemplates)
      .where(inArray(notificationTemplates.templateKey, Object.keys(BUBBLE)));
    expect(Object.fromEntries(rows.map((row) => [row.key, { text: row.text, link: row.link }]))).toEqual(BUBBLE);
  });

  it("writes the day as Bubble does — the first letter of the day's name, then dd.mm.yy; for the grower's and transporter's messages the date alone", async () => {
    const days = ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"];
    const rows = [
      ...(await db.execute<{ withDay: string; dateOnly: string }>(sql`
        select public.message_trade_date(d::date, true) as "withDay", public.message_trade_date(d::date, false) as "dateOnly"
        from unnest(${sql.raw(`array[${days.map((d) => `'${d}'`).join(",")}]`)}::text[]) with ordinality as t(d, i)
        order by i
      `)),
    ];
    // ראשון, שני, שלישי, רביעי, חמישי, שישי, שבת.
    expect(rows.map((row) => row.withDay)).toEqual(["ר 08.11.26", "ש 09.11.26", "ש 10.11.26", "ר 11.11.26", "ח 12.11.26", "ש 13.11.26", "ש 14.11.26"]);
    expect(rows.map((row) => row.dateOnly)).toEqual([" 08.11.26", " 09.11.26", " 10.11.26", " 11.11.26", " 12.11.26", " 13.11.26", " 14.11.26"]);
  });

  it("a pick reminder is Bubble's — to a group by the company's name, to each person by first name — then a blank line and the link", async () => {
    for (const how of ["group", "people"] as const) {
      const companyId = await officeRecipient(how);
      const id = await queued("pick_reminder", companyId, { tradeDate: "2026-11-12" });
      const resolved = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: id });
      expect(resolved.error).toBeNull();
      const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));
      const name = how === "group" ? company!.name : "רונית";
      expect(resolved.data![0]!.message).toBe(`שלום ${name}. אנא עדכנו הערכת קטיף ליום ח 12.11.26 \n\n${ORI}/grower/picks`);
    }
  }, 60000);

  it("the office's new-order message names who sent it and lists the order as it stands: product, the price the customer was shown, quantity, each line's comment, the general comment", async () => {
    const tag = randomUUID().slice(0, 8);
    const customer = await createTestCompany(`לקוח בדיקה ${tag}`, "customer");
    cleanupFns.push(() => deleteTestCompany(customer.id));
    const product = async (family: string, variety: string, sizes: string | null) => {
      const [f] = await db.insert(productFamilies).values({ name: family }).returning();
      cleanupFns.push(async () => {
        await db.delete(productFamilies).where(eq(productFamilies.id, f!.id));
      });
      const [v] = await db.insert(productVarieties).values({ familyId: f!.id, name: variety, sizes }).returning();
      cleanupFns.push(async () => {
        await db.delete(productVarieties).where(eq(productVarieties.id, v!.id));
      });
      return v!.id;
    };
    const tomato = await product(`עגבניה ${tag}`, "אשכולות", "XL");
    const eggplant = await product(`חציל ${tag}`, `חציל ${tag}`, null); // family and variety named alike: written once
    const mango = await product(`מנגו ${tag}`, "קיט", "12");
    const apple = await product(`תפוח ${tag}`, "גאלה", null);
    const [order] = await db
      .insert(dailyOrders)
      .values({ tradingDayId: dayId, customerCompanyId: customer.id, comment: "להביא לפני 6" })
      .returning();
    cleanupFns.push(async () => {
      await db.delete(dailyOrders).where(eq(dailyOrders.id, order!.id));
    });
    await db.insert(dailyOrderProducts).values([
      { dailyOrderId: order!.id, productVarietyId: tomato, palletsOrdered: "1", priceType: "record_plus_1" },
      { dailyOrderId: order!.id, productVarietyId: eggplant, palletsOrdered: "2.5", comment: "חצי משטח", priceType: "fixed", price: "5" },
      { dailyOrderId: order!.id, productVarietyId: mango, palletsOrdered: "1", priceType: "range", priceRangeFrom: "15", priceRangeTo: "17" },
      // Zeroed (kept only for an allocation): not part of the order any more.
      { dailyOrderId: order!.id, productVarietyId: apple, palletsOrdered: "0" },
    ]);

    const id = await queued("order_submitted", await officeRecipient("people"), {
      companyName: "שוק הבדיקה",
      dailyOrderId: order!.id,
      submittedByName: "דודו אטיאס",
    });
    const resolved = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: id });
    expect(resolved.error).toBeNull();
    expect(resolved.data![0]!.message).toBe(
      "שלום רונית. \nשוק הבדיקה שלחו הזמנה על ידי דודו אטיאס.\nלהלן מצב ההזמנה הנוכחי שלהם:\n\n" +
        `חציל ${tag}  |  מחיר: ₪5  |  כמות: 2.5 (חצי משטח)\n` +
        `מנגו ${tag} קיט 12  |  מחיר: ₪17 - ₪15  |  כמות: 1 \n` +
        `עגבניה ${tag} אשכולות XL  |  מחיר: תקליט + ₪1  |  כמות: 1 \n` +
        "הערה כללית:\t להביא לפני 6" +
        `\n\n${ORI}/backoffice/distributor-customer`,
    );
  }, 60000);

  it("an order message queued before 0102 (no order on it) still goes out: named, without the lines", async () => {
    const id = await queued("order_submitted", await officeRecipient("people"), { companyName: "שוק הבדיקה" });
    const resolved = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: id });
    expect(resolved.error).toBeNull();
    expect(resolved.data![0]!.message).toBe(
      `שלום רונית. \nשוק הבדיקה שלחו הזמנה על ידי .\nלהלן מצב ההזמנה הנוכחי שלהם:\n\n\n\n${ORI}/backoffice/distributor-customer`,
    );
  }, 30000);

  it("the grower's and transporter's messages: the sale grouped by customer in bold, half pallets as they are, 'also sent to the transporter' only when there is one", async () => {
    const tag = randomUUID().slice(0, 8);
    const transporter = await createTestCompany(`מוביל בדיקה ${tag}`, "transporter");
    cleanupFns.push(() => deleteTestCompany(transporter.id));
    const withTransporter = await createTestCompany(`מגדל עם מוביל ${tag}`, "grower");
    cleanupFns.push(() => deleteTestCompany(withTransporter.id));
    await db.update(companies).set({ transporterCompanyId: transporter.id }).where(eq(companies.id, withTransporter.id));
    const withoutTransporter = await createTestCompany(`מגדל בלי מוביל ${tag}`, "grower");
    cleanupFns.push(() => deleteTestCompany(withoutTransporter.id));
    const lines = [
      { familyName: "כרוב", varietyName: "לבן", varietySizes: null, quantityPallets: 2.5, customerCompanyName: "ירק הגליל" },
      { familyName: "כרוב", varietyName: "אדום", varietySizes: "גדול", quantityPallets: 1, customerCompanyName: "א.צ" },
      { familyName: "חציל", varietyName: "חציל", varietySizes: null, quantityPallets: 3, customerCompanyName: "ירק הגליל" },
    ];
    const details = "*א.צ*\n1 כרוב\t  אדום גדול\n*ירק הגליל*\n3  חציל \n2.5 כרוב\t  לבן ";
    const preview = async (templateKey: string, companyId: string, payload: Record<string, unknown>) => {
      const id = await queued(templateKey, companyId, { tradeDate: "2026-11-12", lines, ...payload });
      const result = await admin.rpc("resolve_outbox_preview", { p_outbox_id: id });
      expect(result.error).toBeNull();
      return result.data;
    };
    expect(await preview("close_arrangement_grower", withTransporter.id, {})).toBe(
      `היי, \n\nלהלן הסידור של ${withTransporter.name} לתאריך  12.11.26. \n\n${details} \n\nהודעה זו נשלחה גם למוביל`,
    );
    expect(await preview("close_arrangement_grower", withoutTransporter.id, {})).toBe(
      `היי, \n\nלהלן הסידור של ${withoutTransporter.name} לתאריך  12.11.26. \n\n${details}`,
    );
    expect(await preview("close_arrangement_grower_transporter", transporter.id, { companyName: withTransporter.name, pickupTime: "06:00" })).toBe(
      `היי, \n\nלהלן הסידור של ${withTransporter.name} לתאריך  12.11.26.  \n\n${details} \n\nהמשטחים יהיו מוכנים לאיסוף ב 06:00`,
    );
  }, 60000);

  it("the customer's end-of-day message is Bubble's: a line per allocation — product, the price by its type when they may see it, quantity, grower — then the link", async () => {
    const id = await queued("close_arrangement_customer", await officeRecipient("people"), {
      tradeDate: "2026-11-12",
      canSeePrices: true,
      lines: [
        { familyName: "בננה", varietyName: "קוונדיש", varietySizes: "גדול", quantityPallets: 3, price: 120, priceType: "fixed", growerCompanyName: "משק כהן" },
        { familyName: "אבוקדו", varietyName: "האס", varietySizes: "18", quantityPallets: 2, price: null, priceRangeFrom: 350, priceRangeTo: 420, priceType: "range", growerCompanyName: "חוות הגליל" },
        { familyName: "ענבים", varietyName: "ענבים", varietySizes: null, quantityPallets: 0.5, growerCompanyName: "פרי הגולן" },
      ],
    });
    const resolved = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: id });
    expect(resolved.error).toBeNull();
    expect(resolved.data![0]!.message).toBe(
      "שלום רונית. להלן המוצרים שהזמנת ושתקבל לתאריך ח 12.11.26 מהמגדלים השונים: \n" +
        "אבוקדו האס 18  |  מחיר: ₪420 - ₪350  |  כמות: 2 חוות הגליל\n" +
        "בננה קוונדיש גדול  |  מחיר: ₪120  |  כמות: 3 משק כהן\n" +
        "ענבים  |  כמות: 0.5 פרי הגולן" +
        `\n\n${ORI}/customer/history`,
    );
  }, 30000);

  // Migration 0105: a time the grower chose on their picking screen is the one
  // the transporter is told when the truck closes the pick.
  it("the transporter's message names the time the grower chose", async () => {
    const office = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(office.id));
    const bo = await createTestProfile({ companyId: office.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(bo.userId));
    const backoffice = await signInTestUser(bo.email, bo.password);

    const grower = await createTestGrowerWithProduct({ defaultPickupTime: "07:00" });
    cleanupFns.push(() => deleteTestGrowerWithProduct(grower));
    const transporter = await createTestCompany(`מוביל בדיקה ${randomUUID()}`, "transporter");
    cleanupFns.push(() => deleteTestCompany(transporter.id));
    await db.update(companies).set({ transporterCompanyId: transporter.id }).where(eq(companies.id, grower.companyId));
    // Runs before the transporter is deleted (cleanups run last-in first-out).
    cleanupFns.push(async () => {
      await db.update(companies).set({ transporterCompanyId: null }).where(eq(companies.id, grower.companyId));
    });
    const customer = await createTestCompany(`לקוח בדיקה ${randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(customer.id));

    // An open day (the file's own day is already closed, which set_pick_closed refuses).
    const day = await createTestTradingDay({ initiatedByUserId: bo.userId, phase: "shop_closed" });
    cleanupFns.push(() => deleteTestTradingDay(day.id));
    const [arrangement] = await db.insert(dailyArrangements).values({ tradingDayId: day.id, status: "open" }).returning();
    const [pick] = await db
      .insert(dailyPicks)
      .values({ tradingDayId: day.id, growerCompanyId: grower.companyId, status: "submitted", submittedAt: new Date() })
      .returning();
    const [line] = await db
      .insert(dailyPickProducts)
      .values({ dailyPickId: pick!.id, productVarietyId: grower.varietyId, palletsPicked: "5" })
      .returning();
    const orderLine = await createTestOrderProductLine(day.id, customer.id, grower.varietyId, 2);
    await createTestArrangementRecord({
      dailyArrangementId: arrangement!.id,
      dailyPickProductId: line!.id,
      dailyOrderProductId: orderLine.id,
      customerCompanyId: customer.id,
      quantityPallets: 2,
    });

    const growerProfile = await createTestProfile({ companyId: grower.companyId, role: "grower" });
    cleanupFns.push(() => deleteTestUser(growerProfile.userId));
    const growerClient = await signInTestUser(growerProfile.email, growerProfile.password);
    const chosen = await growerClient.rpc(
      "set_pick_pickup_time",
      toSetPickPickupTimeRpcArgs({ dailyPickId: pick!.id, pickupTime: "05:45" }),
    );
    expect(chosen.error).toBeNull();

    const closed = await backoffice.rpc("set_pick_closed", { p_daily_pick_id: pick!.id, p_closed: true });
    expect(closed.error).toBeNull();

    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.tradingDayId, day.id));
    const forTransporter = rows.filter((r) => r.templateKey === "close_arrangement_grower_transporter");
    expect(forTransporter).toHaveLength(1);
    expect((forTransporter[0]!.payload as { pickupTime?: string }).pickupTime).toBe("05:45");
  }, 60000);
});
