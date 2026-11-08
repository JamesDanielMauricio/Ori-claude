import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { db } from "@ori/db";
import { companies, notificationOutbox, profiles } from "@ori/db/schema";
import type { Database } from "@ori/db/supabase-types";
import {
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
  signInTestUser,
} from "@ori/domain/auth/testing";
import { createTestTradingDay, deleteTestTradingDay } from "@ori/domain/lifecycle-engine/testing";
import { normalizePhoneNumber } from "@ori/shared/phone";
import type { SupabaseClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
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
    ["pick_updated", { companyName: "משק הבדיקה" }, ["משק הבדיקה עדכן/ה"]],
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
        expect(message.startsWith("רונית שלום")).toBe(true);
      }
      const preview = await admin.rpc("resolve_outbox_preview", { p_outbox_id: id });
      expect(preview.error).toBeNull();
      for (const text of expected) expect(preview.data).toContain(text);
    }
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
});
