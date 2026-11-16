import { randomUUID } from "node:crypto";

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
import type { SupabaseClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestOutboxRow } from "./test-helpers";

// Migration 0106 §1: which of a company's WhatsApp group and its people a
// message reaches depends on the message type, the way the old Bubble app did
// it. The templates are the REAL seeded ones.
describe("WhatsApp routing by message type (0106)", () => {
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

  // A company, optionally with a group, with one user per phone given
  // (undefined = no phone on file). Returns the group id and the user ids.
  async function company(kind: "grower" | "customer", opts: { group: boolean; phones: Array<string | undefined> }) {
    const created = await createTestCompany(`חברת בדיקה ${randomUUID()}`, kind);
    cleanupFns.push(() => deleteTestCompany(created.id));
    const group = opts.group ? `grp-${randomUUID()}` : null;
    if (group) await db.update(companies).set({ whatsappGroupId: group }).where(eq(companies.id, created.id));
    const userIds: string[] = [];
    for (const phone of opts.phones) {
      const person = await createTestProfile({
        companyId: created.id,
        role: kind,
        displayName: "דנה כהן",
      });
      cleanupFns.push(() => deleteTestUser(person.userId));
      if (phone !== undefined) {
        // Written around the save-time phone check (0077), the way an old value
        // saved before that rule can still be on file ("12" is not a number).
        await db.transaction(async (tx) => {
          await tx.execute(sql`alter table public.profiles disable trigger profiles_tidy_phone_number`);
          await tx.update(profiles).set({ phoneNumber: phone }).where(eq(profiles.userId, person.userId));
          await tx.execute(sql`alter table public.profiles enable trigger profiles_tidy_phone_number`);
        });
      }
      userIds.push(person.userId);
    }
    return { id: created.id, group, userIds };
  }

  async function resolve(
    templateKey: string,
    recipientType: "grower" | "customer",
    companyId: string,
    recipientUserIds?: string[],
  ) {
    const row = await createTestOutboxRow({
      tradingDayId: dayId,
      recipientType,
      recipientCompanyId: companyId,
      templateKey,
      payload: { tradeDate: "2026-11-08", lines: [], companyName: "משק הבדיקה" },
      ...(recipientUserIds ? { recipientUserIds } : {}),
    });
    cleanupFns.push(async () => {
      await db.delete(notificationOutbox).where(eq(notificationOutbox.id, row.id));
    });
    const { data, error } = await admin.rpc("resolve_outbox_dispatch", { p_outbox_id: row.id });
    expect(error).toBeNull();
    return data!;
  }

  const person = { target: "972501234567", is_group: false };

  it("pick_reminder reaches the group and each person with a usable phone", async () => {
    const grower = await company("grower", { group: true, phones: ["050-123 4567", "12", undefined] });
    const data = await resolve("pick_reminder", "grower", grower.id);
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ target: grower.group, is_group: true });
    expect(data[1]).toMatchObject(person);
  }, 30000);

  it("pick_reminder without a group reaches each person", async () => {
    const grower = await company("grower", { group: false, phones: ["050-123 4567"] });
    const data = await resolve("pick_reminder", "grower", grower.id);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject(person);
  }, 30000);

  it("shop_open never reaches the group", async () => {
    const customer = await company("customer", { group: true, phones: ["050-123 4567"] });
    const data = await resolve("shop_open", "customer", customer.id);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject(person);
  }, 30000);

  it("pick_updated reaches only the group", async () => {
    const withGroup = await company("grower", { group: true, phones: ["050-123 4567"] });
    const data = await resolve("pick_updated", "grower", withGroup.id);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ target: withGroup.group, is_group: true });

    const noGroup = await company("grower", { group: false, phones: ["050-123 4567"] });
    expect(await resolve("pick_updated", "grower", noGroup.id)).toEqual([]);
  }, 30000);

  it("other messages keep group-else-people", async () => {
    const withGroup = await company("customer", { group: true, phones: ["050-123 4567"] });
    const grouped = await resolve("close_arrangement_customer", "customer", withGroup.id);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ target: withGroup.group, is_group: true });

    const noGroup = await company("customer", { group: false, phones: ["050-123 4567"] });
    const people = await resolve("close_arrangement_customer", "customer", noGroup.id);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject(person);
  }, 30000);

  it("a listed row reaches only the listed people even when the company has a group", async () => {
    const customer = await company("customer", { group: true, phones: ["050-123 4567", "052-765 4321"] });
    const data = await resolve("shop_open", "customer", customer.id, [customer.userIds[0]!]);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject(person);
  }, 30000);

  it("outbox_routing names each type's rule", async () => {
    const keys = ["pick_reminder", "shop_open", "pick_updated", "close_arrangement_customer", "order_reminder", "anything_else"];
    const result = await db.execute<{ key: string; rule: string }>(
      sql`select k as key, public.outbox_routing(k) as rule from unnest(${sql.raw(`array[${keys.map((k) => `'${k}'`).join(",")}]::text[]`)}) as t(k)`,
    );
    const rules = Object.fromEntries([...result].map((r) => [r.key, r.rule]));
    expect(rules).toEqual({
      pick_reminder: "group_and_people",
      shop_open: "people_only",
      pick_updated: "group_only",
      close_arrangement_customer: "group_else_people",
      order_reminder: "group_else_people",
      anything_else: "group_else_people",
    });
  }, 30000);
});
