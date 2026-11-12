// CRASH TRAIL (temporary, migration 0096) — remove with it. Who may add and
// who may read a crash record, against the real database (CI's local stack).
// It skips itself once the table is gone, so dropping public.crash_trail
// before this file is deleted cannot fail CI.
import { randomUUID } from "node:crypto";

import { db } from "@ori/db";
import {
  createAnonClient,
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
  signInTestUser,
} from "@ori/domain/auth/testing";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

const [table] = (await db.execute(
  sql`select to_regclass('public.crash_trail')::text as name`,
)) as unknown as Array<{ name: string | null }>;

describe.skipIf(!table?.name)("crash_trail (Crash Trail)", () => {
  const cleanupFns: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await runCleanup(cleanupFns);
  });

  it("anyone adds a record — naming only themselves or nobody — and only backoffice reads them", async () => {
    // A marker in every row this test writes, so it reads and removes its own.
    const marker = `crash-trail-test-${randomUUID()}`;
    cleanupFns.push(async () => {
      await db.execute(sql`delete from public.crash_trail where error like ${`${marker}%`}`);
    });

    const company = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(company.id));
    const customer = await createTestProfile({ companyId: company.id, role: "customer" });
    cleanupFns.push(() => deleteTestUser(customer.userId));
    const admin = await createTestProfile({ companyId: company.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(admin.userId));
    const customerClient = await signInTestUser(customer.email, customer.password);
    const adminClient = await signInTestUser(admin.email, admin.password);
    const anon = createAnonClient();

    const row = (suffix: string, userId: string | null) => ({
      user_id: userId,
      error: `${marker} ${suffix}`,
      screen: "/backoffice/distributor-grower",
      breadcrumbs: [{ at: "2026-11-12T10:00:00.000Z", what: "opened /backoffice/distributor-grower" }],
    });

    // Signed out: a record that names nobody.
    expect((await anon.from("crash_trail").insert(row("anon", null))).error).toBeNull();
    expect((await anon.from("crash_trail").insert(row("anon naming someone", customer.userId))).error).not.toBeNull();
    // Signed in: their own, never someone else's.
    expect((await customerClient.from("crash_trail").insert(row("own", customer.userId))).error).toBeNull();
    expect((await customerClient.from("crash_trail").insert(row("someone else", admin.userId))).error).not.toBeNull();
    // Nobody sets the time, and the limits hold.
    expect(
      (await customerClient.from("crash_trail").insert({ ...row("dated", null), created_at: "2000-01-01T00:00:00Z" })).error,
    ).not.toBeNull();
    const tooLong = Array.from({ length: 21 }, () => ({ at: "t", what: "x" }));
    expect((await customerClient.from("crash_trail").insert({ ...row("too long", null), breadcrumbs: tooLong })).error).not.toBeNull();

    // Reading: nobody but backoffice.
    const anonRead = await anon.from("crash_trail").select("error").like("error", `${marker}%`);
    expect(anonRead.data ?? []).toEqual([]);
    const customerRead = await customerClient.from("crash_trail").select("error").like("error", `${marker}%`);
    expect(customerRead.data ?? []).toEqual([]);
    const adminRead = await adminClient.from("crash_trail").select("error, user_id").like("error", `${marker}%`).order("error");
    expect(adminRead.error).toBeNull();
    expect(adminRead.data).toEqual([
      { error: `${marker} anon`, user_id: null },
      { error: `${marker} own`, user_id: customer.userId },
    ]);

    // And nobody changes or removes one through the API.
    await adminClient.from("crash_trail").update({ error: `${marker} changed` }).like("error", `${marker}%`);
    await adminClient.from("crash_trail").delete().like("error", `${marker}%`);
    const after = await adminClient.from("crash_trail").select("error").like("error", `${marker}%`).order("error");
    expect(after.data?.map((r) => r.error)).toEqual([`${marker} anon`, `${marker} own`]);
  });
});
