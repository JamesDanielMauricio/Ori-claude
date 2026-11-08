import { randomUUID } from "node:crypto";

import { db } from "@ori/db";
import { notificationDispatchStatus, notificationOutbox } from "@ori/db/schema";
import { createServiceRoleClient } from "@ori/domain/auth";
import {
  createTestCompany,
  createTestProfile,
  deleteTestCompany,
  deleteTestUser,
  runCleanup,
  signInTestUser,
} from "@ori/domain/auth/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Release workbook task 16 (ORI-019), in the actual Edge runtime: the real
// whatsapp-dispatch function, served by the local Supabase stack behind its
// real gateway (CI starts it with `supabase functions serve` — see ci.yml),
// called over HTTP the way the schedule, the office's nudge and a stranger
// would. Only the service-role key and a backoffice session may start a
// run; everyone else is refused before the function reads a setting or a
// queue row — checked here by reading the queue and the run status back.
//
// WhatsApp stays switched off throughout, so an allowed run sends nothing.
describe("whatsapp-dispatch in the Edge runtime: who may start a run", () => {
  // Set for every test worker by vitest.config.ts (local-stack values only —
  // the config refuses anything else).
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL ?? "",
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? "",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  };
  const url = `${env.SUPABASE_URL}/functions/v1/whatsapp-dispatch`;
  const cleanupFns: Array<() => Promise<void>> = [];
  const tokens: Record<"backoffice" | "customer" | "noProfile", string> = { backoffice: "", customer: "", noProfile: "" };

  async function accessToken(email: string, password: string): Promise<string> {
    const client = await signInTestUser(email, password);
    const { data } = await client.auth.getSession();
    expect(data.session?.access_token).toBeTruthy();
    return data.session!.access_token;
  }

  beforeAll(async () => {
    const office = await createTestCompany();
    cleanupFns.push(() => deleteTestCompany(office.id));
    const bo = await createTestProfile({ companyId: office.id, role: "backoffice" });
    cleanupFns.push(() => deleteTestUser(bo.userId));
    tokens.backoffice = await accessToken(bo.email, bo.password);

    const shop = await createTestCompany(`לקוח בדיקה ${randomUUID()}`, "customer");
    cleanupFns.push(() => deleteTestCompany(shop.id));
    const customer = await createTestProfile({ companyId: shop.id, role: "customer" });
    cleanupFns.push(() => deleteTestUser(customer.userId));
    tokens.customer = await accessToken(customer.email, customer.password);

    const email = `test-${randomUUID()}@example.test`;
    const password = `Correct-Horse-${randomUUID()}`;
    const created = await createServiceRoleClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    cleanupFns.push(() => deleteTestUser(created.data.user!.id));
    tokens.noProfile = await accessToken(email, password);
  }, 60000);

  afterAll(async () => {
    await runCleanup(cleanupFns);
  });

  const call = (token: string | null, body: unknown = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const queueAndStatus = async () =>
    JSON.stringify([
      await db.select().from(notificationOutbox).orderBy(notificationOutbox.id),
      await db.select().from(notificationDispatchStatus),
    ]);

  it("is being served (the CI step that starts it ran)", async () => {
    const preflight = await fetch(url, { method: "OPTIONS" });
    expect(preflight.status).toBe(200);
  });

  it("refuses everyone but the system and backoffice staff, before touching anything", async () => {
    const before = await queueAndStatus();
    const cases: Array<[string, string | null, unknown, number]> = [
      ["no token (the gateway)", null, {}, 401],
      ["not a real token (the gateway)", "not-a-token", {}, 401],
      ["the public anon key", env.SUPABASE_ANON_KEY, {}, 403],
      ["a customer's session", tokens.customer, {}, 403],
      ["a session with no profile", tokens.noProfile, {}, 403],
      ["backoffice asking for live credentials", tokens.backoffice, { forceEnv: "live" }, 403],
    ];
    for (const [name, token, body, status] of cases) {
      const response = await call(token, body);
      expect(response.status, name).toBe(status);
      await response.body?.cancel();
    }
    expect(await queueAndStatus()).toBe(before);
  }, 60000);

  it("lets a backoffice session and the service-role key start a run", async () => {
    for (const [name, token] of [["backoffice", tokens.backoffice], ["service role", env.SUPABASE_SERVICE_ROLE_KEY]] as const) {
      const response = await call(token);
      expect(response.status, name).toBe(200);
      const summary = (await response.json()) as { processed: number; sent: number };
      expect(typeof summary.processed, name).toBe("number");
      expect(summary.sent, name).toBe(0);
    }
  }, 60000);
});
