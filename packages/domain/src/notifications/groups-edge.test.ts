import { randomUUID } from "node:crypto";

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

// The WhatsApp group list (supabase/functions/whatsapp-groups) in the actual
// Edge runtime: served by the local Supabase stack behind its real gateway
// (CI starts every function with `supabase functions serve` — see ci.yml) and
// called over HTTP the way the company screens' picker calls it. Its Deno
// tests cover the logic with fakes; this checks what only the real runtime
// can: that the function boots with the files it imports from
// ../whatsapp-dispatch, that the gateway checks its tokens (verify_jwt in
// supabase/config.toml), and that the dispatcher's caller check, with the
// dispatcher's real database calls, lets only backoffice staff in.
//
// Nothing here can reach Green API: every refused call stops before the
// credentials are read, and the one allowed call runs only in CI, where the
// served functions have no WhatsApp secrets.
describe("whatsapp-groups in the Edge runtime: who may list the groups", () => {
  // Set for every test worker by vitest.config.ts (local-stack values only —
  // the config refuses anything else).
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL ?? "",
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? "",
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  };
  const url = `${env.SUPABASE_URL}/functions/v1/whatsapp-groups`;
  const cleanupFns: Array<() => Promise<void>> = [];
  const tokens: Record<"backoffice" | "customer" | "noProfile", string> = {
    backoffice: "",
    customer: "",
    noProfile: "",
  };

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
    const created = await createServiceRoleClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error).toBeNull();
    cleanupFns.push(() => deleteTestUser(created.data.user!.id));
    tokens.noProfile = await accessToken(email, password);
  }, 60000);

  afterAll(async () => {
    await runCleanup(cleanupFns);
  });

  const call = (token: string | null) =>
    fetch(url, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("is being served — it boots with the files it imports from whatsapp-dispatch", async () => {
    // Its worker starts on its first request, so give it the time the CI
    // step gives the dispatcher to come up.
    let status = 0;
    for (let attempt = 0; attempt < 30 && status !== 200; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
      const preflight = await fetch(url, { method: "OPTIONS" });
      status = preflight.status;
      await preflight.body?.cancel();
    }
    expect(status).toBe(200);
  }, 90000);

  it("refuses everyone but a signed-in backoffice user — the service-role key too", async () => {
    const cases: Array<[string, string | null, number, string | null]> = [
      ["no token (the gateway)", null, 401, null],
      ["not a real token (the gateway)", "not-a-token", 401, null],
      ["the public anon key", env.SUPABASE_ANON_KEY, 403, "refused"],
      ["a customer's session", tokens.customer, 403, "refused"],
      ["a session with no profile", tokens.noProfile, 403, "refused"],
      ["the service-role key", env.SUPABASE_SERVICE_ROLE_KEY, 403, "refused"],
    ];
    for (const [name, token, status, kind] of cases) {
      const response = await call(token);
      expect(response.status, name).toBe(status);
      const body = (await response.json().catch(() => null)) as { kind?: string } | null;
      // The gateway's own refusals carry no kind; the function's always do.
      if (kind) expect(body?.kind, name).toBe(kind);
    }
  }, 60000);

  // Only in CI, where the served functions have no WhatsApp secrets: run
  // elsewhere — against a stack given real ones — it would ask Green API.
  it.runIf(process.env.CI)(
    "lets a backoffice session through, as far as the missing WhatsApp credentials",
    async () => {
      const response = await call(tokens.backoffice);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ kind: "not_configured", env: "dev" });
    },
    60000,
  );
});
