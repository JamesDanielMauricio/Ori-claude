import { randomUUID } from "node:crypto";

import { db } from "@ori/db";
import { companies, notificationDispatchStatus, notificationOutbox, notificationSettings } from "@ori/db/schema";
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
import { createTestTradingDay, deleteTestTradingDay } from "@ori/domain/lifecycle-engine/testing";
import type { SupabaseClient } from "@supabase/supabase-js";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { drainNotificationOutbox } from "./drain";
import { createTestOutboxRow, FakeNotificationChannel } from "./test-helpers";

// Migration 0078 (release workbook task 16 — ORI-007, ORI-019, ORI-020): how
// the WhatsApp queue is worked. Claims stop two runs sending the same
// message; a failed try waits before the next; a WhatsApp-wide problem costs
// no try; nothing older than 12 hours goes out on its own; staff can "send
// again"; and only the dispatcher and backoffice can touch any of it. Rows are
// read back over the trusted connection (`db`, which no security rule
// filters), and time is moved by editing timestamps there.
//
// notification_settings and notification_dispatch_status are single rows
// shared by the whole database; every test puts them back (afterEach), and the
// suite runs one file at a time (vitest.config.ts), as notifications.test.ts
// relies on too.
describe("WhatsApp queue: claims, waits, the 12-hour rule, send again, and who may touch it (0078)", () => {
  type Client = SupabaseClient<Database>;
  const cleanupFns: Array<() => Promise<void>> = [];
  const fileCleanupFns: Array<() => Promise<void>> = [];
  let service: Client;
  let admin: Client;
  let customer: Client;
  let grower: Client;
  let noProfile: Client;
  let anon: Client;
  let adminUserId: string;
  let dayId: string;

  async function signedIn(companyId: string, role: "backoffice" | "grower" | "customer") {
    const profile = await createTestProfile({ companyId, role });
    fileCleanupFns.push(() => deleteTestUser(profile.userId));
    return { client: await signInTestUser(profile.email, profile.password), userId: profile.userId };
  }

  beforeAll(async () => {
    service = createServiceRoleClient();
    const office = await createTestCompany();
    fileCleanupFns.push(() => deleteTestCompany(office.id));
    const bo = await signedIn(office.id, "backoffice");
    admin = bo.client;
    adminUserId = bo.userId;
    const customerCompany = await createTestCompany(`לקוח בדיקה ${randomUUID()}`, "customer");
    fileCleanupFns.push(() => deleteTestCompany(customerCompany.id));
    customer = (await signedIn(customerCompany.id, "customer")).client;
    const growerCompany = await createTestCompany(`מגדל בדיקה ${randomUUID()}`, "grower");
    fileCleanupFns.push(() => deleteTestCompany(growerCompany.id));
    grower = (await signedIn(growerCompany.id, "grower")).client;
    const email = `test-${randomUUID()}@example.test`;
    const password = `Correct-Horse-${randomUUID()}`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    fileCleanupFns.push(() => deleteTestUser(created.data.user!.id));
    noProfile = await signInTestUser(email, password);
    anon = createAnonClient();
    // A closed day: nothing here needs an open one, and a closed day does not
    // compete for the single open-day slot.
    const day = await createTestTradingDay({ initiatedByUserId: adminUserId, phase: "closed" });
    fileCleanupFns.push(() => deleteTestTradingDay(day.id));
    dayId = day.id;
  });

  afterAll(async () => {
    await runCleanup(fileCleanupFns);
  });

  afterEach(async () => {
    await runCleanup(cleanupFns);
    await db.update(notificationSettings).set({ whatsappEnabled: false }).where(eq(notificationSettings.id, true));
    await db
      .update(notificationDispatchStatus)
      .set({ channelProblem: null, channelProblemSince: null })
      .where(eq(notificationDispatchStatus.id, true));
  });

  // n messages, each to its own company and WhatsApp group, so a send can be
  // traced back to its row.
  async function queue(n: number, options: { createdAt?: Date } = {}) {
    const rows: Array<{ id: string; group: string }> = [];
    for (let i = 0; i < n; i++) {
      const group = `grp-${randomUUID()}`;
      const company = await createTestCompany(`חברת תור ${randomUUID()}`, "customer");
      await db.update(companies).set({ whatsappGroupId: group }).where(eq(companies.id, company.id));
      const row = await createTestOutboxRow({
        tradingDayId: dayId,
        recipientType: "customer",
        recipientCompanyId: company.id,
        templateKey: "order_reminder",
        payload: { tradeDate: "2026-11-08", lines: [] },
        ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      });
      cleanupFns.push(async () => {
        await db.delete(notificationOutbox).where(eq(notificationOutbox.id, row.id));
        await deleteTestCompany(company.id);
      });
      rows.push({ id: row.id, group });
    }
    return rows;
  }

  const read = async (id: string) =>
    (await db.select().from(notificationOutbox).where(eq(notificationOutbox.id, id)))[0]!;
  const statusOf = async (id: string) =>
    (await admin.from("notification_deliveries").select("status").eq("id", id).single()).data?.status;
  const claim = async (worker: string, limit = 100) => {
    const { data, error } = await service.rpc("claim_outbox_rows", { p_worker: worker, p_limit: limit });
    expect(error).toBeNull();
    return (data ?? []).map((row) => row.id);
  };
  const settle = (id: string, worker: string, outcome: "sent" | "failed" | "released" | "skipped", detail: string | null = null) =>
    service.rpc("settle_outbox_row", { p_outbox_id: id, p_worker: worker, p_outcome: outcome, p_detail: detail });
  // Hands back everything a test's claims swept up, so the next claim starts clean.
  async function releaseAll(worker: string) {
    const held = await db.select({ id: notificationOutbox.id }).from(notificationOutbox).where(eq(notificationOutbox.claimedBy, worker));
    for (const row of held) await settle(row.id, worker, "released");
  }

  it("overlapping claims never hand the same message to two runs", async () => {
    const rows = await queue(30);
    const ours = new Set(rows.map((row) => row.id));
    const workers = Array.from({ length: 6 }, () => randomUUID());
    // Six claims at once: each is its own request, so its own transaction.
    const claimed = await Promise.all(workers.map((worker) => claim(worker, 10)));
    const all = claimed.flat().filter((id) => ours.has(id));
    expect(new Set(all).size).toBe(all.length);
    // Every one of our rows that was handed out is held by exactly one run.
    const held = await db.select({ id: notificationOutbox.id, by: notificationOutbox.claimedBy }).from(notificationOutbox).where(inArray(notificationOutbox.id, [...ours]));
    for (const row of held.filter((r) => all.includes(r.id))) {
      expect(workers.filter((w, i) => w === row.by && claimed[i]!.includes(row.id))).toHaveLength(1);
    }
    // While those claims are fresh, a seventh run gets none of them.
    const late = await claim(randomUUID());
    expect(late.filter((id) => all.includes(id))).toEqual([]);
    for (const worker of workers) await releaseAll(worker);
  }, 60000);

  it("two overlapping drains send each message exactly once", async () => {
    const rows = await queue(8);
    await db.update(notificationSettings).set({ whatsappEnabled: true }).where(eq(notificationSettings.id, true));
    // A slow channel, so the two drains really overlap.
    class SlowChannel extends FakeNotificationChannel {
      override async send(message: Parameters<FakeNotificationChannel["send"]>[0]) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return super.send(message);
      }
    }
    const one = new SlowChannel();
    const two = new SlowChannel();
    await Promise.all([
      drainNotificationOutbox({ client: service, channel: one }),
      drainNotificationOutbox({ client: service, channel: two }),
    ]);
    for (const row of rows) {
      const sends = [...one.sent, ...two.sent].filter((m) => m.to === row.group);
      expect(sends, row.group).toHaveLength(1);
      expect((await read(row.id)).sentAt).not.toBeNull();
    }
  }, 60000);

  it("a dead run's claim can be taken after 10 minutes, and the dead run can no longer settle the row", async () => {
    const [row] = await queue(1);
    const dead = randomUUID();
    expect(await claim(dead)).toContain(row!.id);
    expect(await statusOf(row!.id)).toBe("sending");
    expect(await claim(randomUUID())).not.toContain(row!.id);
    await db.update(notificationOutbox).set({ claimedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(notificationOutbox.id, row!.id));
    const rescuer = randomUUID();
    expect(await claim(rescuer)).toContain(row!.id);
    const before = await read(row!.id);
    const late = await settle(row!.id, dead, "failed", "too late");
    expect(late.error).toBeNull();
    expect(late.data?.id ?? null).toBeNull();
    expect(await read(row!.id)).toEqual(before);
    await releaseAll(rescuer);
  }, 30000);

  it("a failed try waits 2, 10, 30 and 60 minutes, so quick nudges cannot use up the tries; the fifth failure is final", async () => {
    const [row] = await queue(1);
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      await db.update(notificationOutbox).set({ nextAttemptAt: null }).where(eq(notificationOutbox.id, row!.id));
      const worker = randomUUID();
      expect(await claim(worker)).toContain(row!.id);
      const failed = await settle(row!.id, worker, "failed", "Green API responded 500");
      expect(failed.error).toBeNull();
      await releaseAll(worker);
      waits.push(Math.round((Date.parse(failed.data!.next_attempt_at!) - Date.now()) / 60_000));
      if (attempt < 5) {
        // A nudge right now finds nothing to do for this row.
        const nudge = randomUUID();
        expect(await claim(nudge)).not.toContain(row!.id);
        await releaseAll(nudge);
      }
    }
    expect(waits.slice(0, 4)).toEqual([2, 10, 30, 60]);
    expect(await statusOf(row!.id)).toBe("failed");
    await db.update(notificationOutbox).set({ nextAttemptAt: null }).where(eq(notificationOutbox.id, row!.id));
    expect(await claim(randomUUID())).not.toContain(row!.id);
  }, 60000);

  it("a WhatsApp-wide problem costs no try, and the run status keeps it through an idle run until a delivery", async () => {
    const [row] = await queue(1);
    const worker = randomUUID();
    expect(await claim(worker)).toContain(row!.id);
    expect((await settle(row!.id, worker, "released", "Green API responded 401")).error).toBeNull();
    const after = await read(row!.id);
    expect(after.attemptCount).toBe(0);
    expect(after.lastError).toBe("Green API responded 401");
    expect(await statusOf(row!.id)).toBe("waiting");

    expect((await service.rpc("record_dispatch_run", { p_channel_ok: false, p_channel_problem: "Green API responded 401" })).error).toBeNull();
    const first = (await db.select().from(notificationDispatchStatus))[0]!;
    expect((await service.rpc("record_dispatch_run", { p_channel_ok: null })).error).toBeNull();
    const idle = (await db.select().from(notificationDispatchStatus))[0]!;
    expect(idle.channelProblem).toBe("Green API responded 401");
    expect(idle.channelProblemSince).toEqual(first.channelProblemSince);
    expect((await service.rpc("record_dispatch_run", { p_channel_ok: true })).error).toBeNull();
    expect((await db.select().from(notificationDispatchStatus))[0]!.channelProblem).toBeNull();
    const { data: seen } = await admin.from("notification_dispatch_status").select("last_run_at").single();
    expect(seen?.last_run_at).not.toBeNull();
  }, 30000);

  it("a message queued over 12 hours ago is expired and not sent on its own; 'send again' gives it 12 more hours and keeps delivered recipients", async () => {
    const [old] = await queue(1, { createdAt: new Date(Date.now() - 13 * 3600_000) });
    expect(await statusOf(old!.id)).toBe("expired");
    expect(await claim(randomUUID())).not.toContain(old!.id);

    await db.update(notificationOutbox).set({ attemptCount: 5, sentTargets: ["972500000001"] }).where(eq(notificationOutbox.id, old!.id));
    const again = await admin.rpc("retry_outbox_row", { p_outbox_id: old!.id });
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ attempt_count: 0, retry_requested_by: adminUserId, sent_targets: ["972500000001"] });
    expect(await statusOf(old!.id)).toBe("waiting");
    const worker = randomUUID();
    expect(await claim(worker)).toContain(old!.id);
    await releaseAll(worker);
  }, 30000);

  it("'send again' refuses a sent, a skipped and a currently-sending message, and everyone but backoffice", async () => {
    const [sent, skipped, sending, failed] = await queue(4);
    const worker = randomUUID();
    const mine = await claim(worker);
    expect(mine).toEqual(expect.arrayContaining([sent!.id, skipped!.id, sending!.id, failed!.id]));
    await settle(sent!.id, worker, "sent");
    await settle(skipped!.id, worker, "skipped", "Skipped: off");
    await settle(failed!.id, worker, "failed", "x");
    for (const id of [sent!.id, skipped!.id, sending!.id]) {
      const refused = await admin.rpc("retry_outbox_row", { p_outbox_id: id });
      expect(refused.error?.code, id).toBe("P0007");
    }
    for (const [name, client] of [["anon", anon], ["no profile", noProfile], ["customer", customer], ["grower", grower], ["dispatcher", service]] as const) {
      const before = await read(failed!.id);
      const refused = await client.rpc("retry_outbox_row", { p_outbox_id: failed!.id });
      expect(refused.error, name).not.toBeNull();
      expect(await read(failed!.id), name).toEqual(before);
    }
    expect((await admin.rpc("retry_outbox_row", { p_outbox_id: failed!.id })).error).toBeNull();
    await releaseAll(worker);
  }, 60000);

  it("signed-out, no-profile, customer and grower callers cannot claim, settle, resolve, read or change the queue", async () => {
    const [row] = await queue(1);
    const snapshot = async () =>
      JSON.stringify([await read(row!.id), (await db.select().from(notificationDispatchStatus))[0]]);
    for (const [name, client] of [["anon", anon], ["no profile", noProfile], ["customer", customer], ["grower", grower]] as const) {
      const before = await snapshot();
      const claimed = await client.rpc("claim_outbox_rows", { p_worker: randomUUID(), p_limit: 100 });
      expect(claimed.data ?? [], name).toEqual([]);
      await client.rpc("settle_outbox_row", { p_outbox_id: row!.id, p_worker: randomUUID(), p_outcome: "sent" });
      await client.rpc("record_dispatch_run", { p_channel_ok: false, p_channel_problem: "spoofed" });
      const resolved = await client.rpc("resolve_outbox_dispatch", { p_outbox_id: row!.id });
      expect(resolved.error, `${name} resolve`).not.toBeNull();
      const reads = {
        notification_outbox: await client.from("notification_outbox").select("id"),
        notification_settings: await client.from("notification_settings").select("id"),
        notification_dispatch_status: await client.from("notification_dispatch_status").select("id"),
        notification_deliveries: await client.from("notification_deliveries").select("id"),
      };
      for (const [table, { data }] of Object.entries(reads)) expect(data ?? [], `${name} reads ${table}`).toEqual([]);
      expect(await snapshot(), `${name} changed nothing`).toBe(before);
    }
    // Signed out, the queue functions are not even callable.
    const anonClaim = await anon.rpc("claim_outbox_rows", { p_worker: randomUUID(), p_limit: 1 });
    expect(anonClaim.error?.code).toBe("42501");
  }, 60000);

  it("backoffice sees the queue and the run status; the dispatcher reads what it needs", async () => {
    const [row] = await queue(1);
    const view = await admin.from("notification_deliveries").select("id, status, recipient_name, delivered_count").eq("id", row!.id).single();
    expect(view.error).toBeNull();
    expect(view.data).toMatchObject({ id: row!.id, status: "waiting", delivered_count: 0 });
    expect((await admin.from("notification_dispatch_status").select("channel_problem").single()).error).toBeNull();
    expect((await service.from("notification_settings").select("whatsapp_enabled").single()).error).toBeNull();
    expect((await service.from("notification_templates").select("template_key").limit(1)).error).toBeNull();
    const resolved = await service.rpc("resolve_outbox_dispatch", { p_outbox_id: row!.id });
    expect(resolved.error).toBeNull();
    expect(resolved.data).toEqual([expect.objectContaining({ target: row!.group, is_group: true })]);
  }, 30000);
});
