// Tests for the WhatsApp dispatcher, in Deno (the runtime it ships on).
//
// Run (from the repo root; DENO_NO_PACKAGE_JSON keeps Deno from reading —
// and rewriting — the pnpm workspace's package.json):
//   DENO_NO_PACKAGE_JSON=1 deno test --allow-env --allow-read --allow-net supabase/functions/whatsapp-dispatch/
//
// - Everything except the last section uses a fake database and a fake
//   Green API: no network, safe anywhere.
// - "against the real database" runs only when DISPATCH_IT=1 (CI sets it,
//   after the local Supabase stack is up and migrated). It refuses to run
//   against anything but this machine. It runs the real handler and the real
//   db.ts against the real queue functions: two overlapping runs, a rejected
//   token, a provider error, a network error carrying the token.

import { assert, assertEquals, assertFalse, assertMatch } from "jsr:@std/assert@1";

import {
  BATCH_SIZE,
  type ClaimedRow,
  createDispatchHandler,
  type DispatchDb,
  type DispatchTarget,
  type HandlerDeps,
  type NotificationSettingsRow,
  type Outcome,
  RUN_BUDGET_MS,
} from "./handler.ts";
import { normalizePhoneNumber, toWhatsAppPersonalNumber } from "./phone.ts";
import { redactSecrets, sendWhatsAppMessage } from "./provider.ts";

const SERVICE_KEY = "service-role-key-for-tests";
const LIVE = { WHATSAPP_ENV: "live", WHATSAPP_LIVE_ID_INSTANCE: "7103000001", WHATSAPP_LIVE_API_TOKEN: "live-secret-token-abc" };
const DEV = { WHATSAPP_DEV_ID_INSTANCE: "7103000002", WHATSAPP_DEV_API_TOKEN: "dev-secret-token-xyz" };

const jwt = (claims: Record<string, unknown>) =>
  `${btoa(JSON.stringify({ alg: "HS256" }))}.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`;
const ANON = jwt({ role: "anon" });
const SERVICE_JWT = jwt({ role: "service_role" });
const SESSION = { backoffice: "session-backoffice", customer: "session-customer", noProfile: "session-no-profile", broken: "session-expired" };

const ALL_ON: NotificationSettingsRow = {
  whatsapp_enabled: true,
  notify_growers_on_business_day_open: true,
  shop_open_whatsapp_enabled: true,
  close_arrangement_customer_whatsapp_enabled: true,
  close_arrangement_grower_whatsapp_enabled: true,
  whatsapp_dev_override_phone: null,
};

// A fake queue: hands out its rows once, and records what the handler did.
class FakeDb implements DispatchDb {
  calls: string[] = [];
  settled: Array<{ id: string; outcome: Outcome; detail: string | null }> = [];
  delivered: Array<{ id: string; target: string }> = [];
  runs: Array<{ ok: boolean | null; problem: string | null }> = [];
  failSettle = false;
  authDown = false;
  constructor(
    public rows: Array<ClaimedRow & { targets?: DispatchTarget[]; preview?: string }> = [],
    public settingsRow: NotificationSettingsRow = ALL_ON,
  ) {}
  userIdForToken(token: string) {
    this.calls.push("auth");
    if (this.authDown) return Promise.reject(new Error("auth unavailable"));
    const users: Record<string, string> = { [SESSION.backoffice]: "u-bo", [SESSION.customer]: "u-cust", [SESSION.noProfile]: "u-none" };
    return Promise.resolve(users[token] ?? null);
  }
  profileRole(userId: string) {
    this.calls.push("profile");
    return Promise.resolve(({ "u-bo": "backoffice", "u-cust": "customer" } as Record<string, string>)[userId] ?? null);
  }
  settings() {
    this.calls.push("settings");
    return Promise.resolve(this.settingsRow);
  }
  claim(_worker: string, limit: number) {
    this.calls.push(`claim:${limit}`);
    const out = this.rows.splice(0, limit);
    return Promise.resolve(out.map(({ id, template_key, sent_targets }) => ({ id, template_key, sent_targets })));
  }
  private all = new Map<string, { targets?: DispatchTarget[]; preview?: string }>();
  seedLookup() {
    for (const r of this.rows) this.all.set(r.id, r);
    return this;
  }
  resolve(id: string) {
    this.calls.push(`resolve:${id}`);
    const r = this.all.get(id);
    return r?.targets ? Promise.resolve(r.targets) : Promise.reject(new Error(`NOT_FOUND: ${id}`));
  }
  preview(id: string) {
    this.calls.push(`preview:${id}`);
    return Promise.resolve(this.all.get(id)?.preview ?? `preview of ${id}`);
  }
  targetSent(id: string, target: string) {
    this.delivered.push({ id, target });
    return Promise.resolve();
  }
  settle(id: string, _worker: string, outcome: Outcome, detail?: string | null) {
    if (this.failSettle) return Promise.reject(new Error("database went away"));
    this.settled.push({ id, outcome, detail: detail ?? null });
    return Promise.resolve();
  }
  recordRun(ok: boolean | null, problem: string | null) {
    this.runs.push({ ok, problem });
    return Promise.resolve();
  }
}

// A fake Green API: records every send; `reply` decides each answer.
function fakeGreenApi(reply: (chatId: string, url: string) => Response | Promise<Response> = () => Response.json({ idMessage: "1" })) {
  const sent: Array<{ chatId: string; message: string; url: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { chatId: string; message: string };
    sent.push({ ...body, url });
    return await reply(body.chatId, url);
  }) as typeof fetch;
  return { sent, fetchImpl };
}

function handlerWith(db: FakeDb, env: Record<string, string>, fetchImpl: typeof fetch, extra: Partial<HandlerDeps> = {}) {
  const vars: Record<string, string> = { SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ...env };
  return createDispatchHandler({ env: (n) => vars[n], db, fetch: fetchImpl, log: () => {}, ...extra });
}

const post = (token: string | null, body?: unknown) =>
  new Request("http://localhost/whatsapp-dispatch", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ---------------------------------------------------------------- phone rule

Deno.test("phone rule matches packages/shared/src/phone-cases.json", async () => {
  const { cases } = JSON.parse(
    await Deno.readTextFile(new URL("../../../packages/shared/src/phone-cases.json", import.meta.url)),
  ) as { cases: Array<{ input: string | null; local: string | null }> };
  assert(cases.length > 30);
  for (const c of cases) {
    assertEquals(normalizePhoneNumber(c.input), c.local, `input ${JSON.stringify(c.input)}`);
    const address = c.local === null ? null : c.local.startsWith("+") ? c.local.slice(1) : `972${c.local.slice(1)}`;
    assertEquals(toWhatsAppPersonalNumber(c.input), address);
  }
});

// ------------------------------------------------------------------ provider

Deno.test("provider: an error repeating the URL never keeps the token or the instance id", () => {
  const creds = { idInstance: "7103123456", apiToken: "abcDEF123secret" };
  const out = redactSecrets(
    "error sending request for url (https://7103.api.greenapi.com/waInstance7103123456/sendMessage/abcDEF123secret): client error; token abcDEF123secret",
    creds,
  );
  assertFalse(out.includes("abcDEF123secret"));
  assertFalse(out.includes("7103123456"));
  assertMatch(out, /waInstance\*\*\*\/sendMessage\/\*\*\*/);
});

Deno.test("provider: failure kinds — account (401/403/466), temporary (429/5xx/network), this message (other 4xx)", async () => {
  const creds = { idInstance: "1", apiToken: "tok-12345" };
  const kindFor = async (reply: () => Response | Promise<Response>) => {
    const r = await sendWhatsAppMessage((() => reply()) as unknown as typeof fetch, creds, "972500000001", false, "hi");
    return r.ok ? "ok" : r.kind;
  };
  assertEquals(await kindFor(() => new Response("", { status: 200 })), "ok");
  for (const s of [401, 403, 466]) assertEquals(await kindFor(() => new Response("no", { status: s })), "channel", `${s}`);
  for (const s of [429, 500, 502, 503]) assertEquals(await kindFor(() => new Response("busy", { status: s })), "transient", `${s}`);
  for (const s of [400, 404]) assertEquals(await kindFor(() => new Response("bad", { status: s })), "message", `${s}`);
  assertEquals(await kindFor(() => Promise.reject(new TypeError("connection reset"))), "transient");
  const missing = await sendWhatsAppMessage(fetch, { idInstance: "", apiToken: "" }, "972500000001", false, "hi");
  assert(!missing.ok && missing.kind === "channel");
});

Deno.test("provider: addresses a group as @g.us and a person as @c.us, with a timeout", async () => {
  const seen: Array<{ chatId: string; signal: boolean }> = [];
  const f = ((_u: string, init: RequestInit) => {
    seen.push({ chatId: JSON.parse(String(init.body)).chatId, signal: init.signal instanceof AbortSignal });
    return Promise.resolve(new Response("{}"));
  }) as unknown as typeof fetch;
  await sendWhatsAppMessage(f, { idInstance: "1", apiToken: "t-1234" }, "120363000000000001", true, "x");
  await sendWhatsAppMessage(f, { idInstance: "1", apiToken: "t-1234" }, "972500000001", false, "x");
  assertEquals(seen, [
    { chatId: "120363000000000001@g.us", signal: true },
    { chatId: "972500000001@c.us", signal: true },
  ]);
});

// ------------------------------------------------------------ who may start a run

Deno.test("refused callers never reach the settings or the queue", async () => {
  for (const [name, token, status] of [
    ["no token", null, 401],
    ["anon key", ANON, 403],
    ["customer session", SESSION.customer, 403],
    ["signed in, no profile", SESSION.noProfile, 403],
    ["expired session", SESSION.broken, 401],
  ] as const) {
    const db = new FakeDb([{ id: "r1", template_key: "order_reminder", sent_targets: [] }]);
    const api = fakeGreenApi();
    const res = await handlerWith(db, LIVE, api.fetchImpl)(post(token, {}));
    assertEquals(res.status, status, name);
    assertFalse(db.calls.some((c) => c === "settings" || c.startsWith("claim")), `${name}: ${db.calls.join(",")}`);
    assertEquals(api.sent.length, 0, name);
    await res.body?.cancel();
  }
});

Deno.test("if the caller cannot be checked, the run is refused (fails closed)", async () => {
  const db = new FakeDb();
  db.authDown = true;
  const res = await handlerWith(db, LIVE, fakeGreenApi().fetchImpl)(post(SESSION.backoffice, {}));
  assertEquals(res.status, 503);
  assertFalse(db.calls.includes("settings"));
  await res.body?.cancel();
});

Deno.test("the service-role key (exact, or as a JWT) and a backoffice session may start a run", async () => {
  for (const token of [SERVICE_KEY, SERVICE_JWT, SESSION.backoffice]) {
    const db = new FakeDb();
    const res = await handlerWith(db, LIVE, fakeGreenApi().fetchImpl)(post(token, {}));
    assertEquals(res.status, 200, token);
    assert(db.calls.includes(`claim:${BATCH_SIZE}`));
    await res.body?.cancel();
  }
});

Deno.test("forceEnv=live: refused for backoffice, accepted with the service-role key", async () => {
  const db = new FakeDb();
  const refused = await handlerWith(db, DEV, fakeGreenApi().fetchImpl)(post(SESSION.backoffice, { forceEnv: "live" }));
  assertEquals(refused.status, 403);
  assertFalse(db.calls.includes("settings"));
  await refused.body?.cancel();

  const db2 = new FakeDb([{ id: "r1", template_key: "order_reminder", sent_targets: [], targets: [{ target: "972500000001", is_group: false, message: "hi" }] }]).seedLookup();
  const api = fakeGreenApi();
  const ok = await handlerWith(db2, { ...DEV, ...LIVE, WHATSAPP_ENV: "dev" }, api.fetchImpl)(post(SERVICE_KEY, { forceEnv: "live" }));
  assertEquals(ok.status, 200);
  assertMatch(api.sent[0].url, /waInstance7103000001\//);
  await ok.body?.cancel();
});

Deno.test("CORS preflight does no work", async () => {
  const db = new FakeDb();
  const res = await handlerWith(db, LIVE, fakeGreenApi().fetchImpl)(new Request("http://localhost/x", { method: "OPTIONS" }));
  assertEquals(res.status, 200);
  assertEquals(db.calls, []);
  await res.body?.cancel();
});

// --------------------------------------------------------------------- sending

Deno.test("live: each recipient once; those reached earlier are not sent again; the row is then sent", async () => {
  const db = new FakeDb([
    { id: "group", template_key: "order_reminder", sent_targets: [], targets: [{ target: "120363000000000001", is_group: true, message: "לקבוצה" }] },
    {
      id: "people",
      template_key: "pick_reminder",
      sent_targets: ["972500000001"],
      targets: [
        { target: "972500000001", is_group: false, message: "a" },
        { target: "972500000002", is_group: false, message: "b" },
      ],
    },
  ]).seedLookup();
  const api = fakeGreenApi();
  const res = await handlerWith(db, LIVE, api.fetchImpl)(post(SERVICE_KEY));
  const summary = await res.json();
  assertEquals(api.sent.map((s) => s.chatId), ["120363000000000001@g.us", "972500000002@c.us"]);
  assertEquals(db.delivered, [{ id: "group", target: "120363000000000001" }, { id: "people", target: "972500000002" }]);
  assertEquals(db.settled.map((s) => `${s.id}:${s.outcome}`), ["group:sent", "people:sent"]);
  assertEquals(summary.sent, 2);
  assertEquals(db.runs, [{ ok: true, problem: null }]);
});

Deno.test("live: a temporary failure on one recipient fails the row (a try), keeps the other recipient, never stores the token", async () => {
  const db = new FakeDb([
    {
      id: "r",
      template_key: "pick_reminder",
      sent_targets: [],
      targets: [
        { target: "972500000001", is_group: false, message: "a" },
        { target: "972500000002", is_group: false, message: "b" },
      ],
    },
  ]).seedLookup();
  const api = fakeGreenApi((chatId, url) => {
    if (chatId.startsWith("972500000002")) throw new TypeError(`error sending request for url (${url}): connection reset`);
    return new Response("{}");
  });
  const res = await handlerWith(db, LIVE, api.fetchImpl)(post(SERVICE_KEY));
  await res.body?.cancel();
  assertEquals(db.delivered, [{ id: "r", target: "972500000001" }]);
  assertEquals(db.settled.length, 1);
  assertEquals(db.settled[0].outcome, "failed");
  assertFalse(db.settled[0].detail!.includes(LIVE.WHATSAPP_LIVE_API_TOKEN));
  assertFalse(db.settled[0].detail!.includes(LIVE.WHATSAPP_LIVE_ID_INSTANCE));
});

Deno.test("live: a rejected token stops the run, costs no try, hands every claimed row back, and is reported", async () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({
    id: `r${i}`,
    template_key: "order_reminder",
    sent_targets: [] as string[],
    targets: [{ target: `97250000000${i}`, is_group: false, message: "x" }],
  }));
  const db = new FakeDb(rows).seedLookup();
  const api = fakeGreenApi(() => new Response("Unauthorized", { status: 401 }));
  const res = await handlerWith(db, LIVE, api.fetchImpl)(post(SERVICE_KEY));
  const summary = await res.json();
  assertEquals(api.sent.length, 1, "one call, then the run stops");
  assertEquals(db.settled.map((s) => s.outcome), ["released", "released", "released", "released"]);
  assertMatch(summary.channelProblem, /401/);
  assertEquals(db.runs, [{ ok: false, problem: summary.channelProblem }]);
});

Deno.test("a switched-off template is skipped without sending", async () => {
  const db = new FakeDb([{ id: "r", template_key: "shop_open", sent_targets: [], targets: [] }], { ...ALL_ON, shop_open_whatsapp_enabled: false }).seedLookup();
  const api = fakeGreenApi();
  await (await handlerWith(db, LIVE, api.fetchImpl)(post(SERVICE_KEY))).body?.cancel();
  assertEquals(api.sent.length, 0);
  assertEquals(db.settled[0].outcome, "skipped");
  assertEquals(db.runs, [{ ok: null, problem: null }], "nothing was sent, so nothing is known about WhatsApp");
});

Deno.test("a row that resolves to nobody is closed as sent; one that cannot be resolved is a failed try", async () => {
  const db = new FakeDb([
    { id: "nobody", template_key: "order_reminder", sent_targets: [], targets: [] },
    { id: "missing", template_key: "order_reminder", sent_targets: [] },
  ]).seedLookup();
  await (await handlerWith(db, LIVE, fakeGreenApi().fetchImpl)(post(SERVICE_KEY))).body?.cancel();
  assertEquals(db.settled.map((s) => `${s.id}:${s.outcome}`), ["nobody:sent", "missing:failed"]);
});

Deno.test("dev: every row goes once to the test phone (tidied); no test phone = a WhatsApp-wide problem", async () => {
  const rows = () => [
    { id: "r1", template_key: "order_reminder", sent_targets: [], targets: [{ target: "972599999999", is_group: false, message: "real" }], preview: "תצוגה 1" },
    { id: "r2", template_key: "order_reminder", sent_targets: [], preview: "תצוגה 2" },
  ];
  const db = new FakeDb(rows(), { ...ALL_ON, whatsapp_dev_override_phone: "+972 50-111 2222" }).seedLookup();
  const api = fakeGreenApi();
  await (await handlerWith(db, DEV, api.fetchImpl)(post(SERVICE_KEY))).body?.cancel();
  assertEquals(api.sent.map((s) => [s.chatId, s.message]), [["972501112222@c.us", "תצוגה 1"], ["972501112222@c.us", "תצוגה 2"]]);
  assertFalse(db.calls.some((c) => c.startsWith("resolve")), "dev never resolves real recipients");
  assertMatch(api.sent[0].url, /waInstance7103000002\//);

  const noPhone = new FakeDb(rows(), ALL_ON).seedLookup();
  const api2 = fakeGreenApi();
  const res = await handlerWith(noPhone, DEV, api2.fetchImpl)(post(SERVICE_KEY));
  const summary = await res.json();
  assertEquals(api2.sent.length, 0);
  assertEquals(noPhone.settled.map((s) => s.outcome), ["released", "released"]);
  assertMatch(summary.channelProblem, /not set/);
});

Deno.test("the time budget: rows not started in time are handed back for the next run", async () => {
  let t = 0;
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, template_key: "order_reminder", sent_targets: [] as string[], targets: [{ target: `97250000000${i}`, is_group: false, message: "x" }] }));
  const db = new FakeDb(rows).seedLookup();
  const api = fakeGreenApi(() => {
    t += RUN_BUDGET_MS + 1; // the first send takes longer than the whole budget
    return new Response("{}");
  });
  await (await handlerWith(db, LIVE, api.fetchImpl, { now: () => t })(post(SERVICE_KEY))).body?.cancel();
  assertEquals(db.settled.map((s) => `${s.id}:${s.outcome}`), ["r0:sent", "r1:released", "r2:released"]);
  assertEquals(db.settled[1].detail, null, "a budget hand-back keeps the row's own last error");
});

Deno.test("a database hiccup while settling is logged and the run goes on", async () => {
  const lines: string[] = [];
  const db = new FakeDb([
    { id: "a", template_key: "order_reminder", sent_targets: [], targets: [{ target: "972500000001", is_group: false, message: "x" }] },
    { id: "b", template_key: "order_reminder", sent_targets: [], targets: [{ target: "972500000002", is_group: false, message: "y" }] },
  ]).seedLookup();
  db.failSettle = true;
  const api = fakeGreenApi();
  const res = await handlerWith(db, LIVE, api.fetchImpl, { log: (l) => lines.push(l) })(post(SERVICE_KEY));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(api.sent.length, 2);
  assert(lines.some((l) => l.includes("could not settle a")));
});

// ------------------------------------------------- against the real database (CI)

const IT = Deno.env.get("DISPATCH_IT") === "1";

Deno.test({
  name: "against the real database: overlapping runs, a rejected token, a provider error, a token-bearing network error",
  ignore: !IT,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const dbUrl = Deno.env.get("DATABASE_URL") ?? "";
    // SECURITY: this test writes to the database it is given, so it ALLOWS
    // only a stack on this machine and PROTECTS AGAINST it ever running
    // against the hosted project (real business data) — the same rule as
    // packages/shared/src/test-targets.ts.
    for (const target of [url, dbUrl]) {
      const host = new URL(target).hostname;
      if (!["127.0.0.1", "localhost"].includes(host)) throw new Error(`DISPATCH_IT refuses ${host} — only a local stack`);
    }

    const { createClient } = await import("npm:@supabase/supabase-js@2");
    const { default: postgres } = await import("npm:postgres@3");
    const { supabaseDispatchDb } = await import("./db.ts");
    // The dispatcher's own way in: the service-role key, which has only the
    // grants migration 0078 gives it — it can read the settings and work the
    // queue, but not write the settings or add rows. Fixtures and read-backs
    // therefore go through a direct database connection (the stack's owner),
    // as packages/domain's tests do; nothing the dispatcher does uses it.
    const dispatcherClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const sql = postgres(dbUrl, { max: 2, prepare: false, onnotice: () => {} });

    type Row = { sent_at: Date | null; attempt_count: number; last_error: string | null; next_attempt_at: Date | null; claimed_at: Date | null };
    const tag = crypto.randomUUID().slice(0, 8);
    const [{ whatsapp_enabled: wasEnabled }] = await sql<{ whatsapp_enabled: boolean }[]>`select whatsapp_enabled from public.notification_settings`;
    const companyIds: string[] = [];
    let dayId: string | null = null;
    try {
      await sql`update public.notification_settings set whatsapp_enabled = true`;
      const date = new Date(Date.UTC(2100, 0, 1) + Math.floor(Math.random() * 3650) * 86400000).toISOString().slice(0, 10);
      [{ id: dayId }] = await sql<{ id: string }[]>`insert into public.trading_days (trade_date, phase) values (${date}, 'closed') returning id`;
      const company = async (group: string) => {
        const [c] = await sql<{ id: string }[]>`
          insert into public.companies (name, type, whatsapp_group_id) values (${`IT ${tag} ${group}`}, 'customer', ${group}) returning id`;
        companyIds.push(c.id);
        return c.id;
      };
      // Queued 11 hours ago — still inside the 12-hour window, and older than
      // anything earlier tests may have left in the queue, so these rows are
      // first in every batch (the claim takes the oldest first).
      const queue = async (companyId: string) =>
        (await sql<{ id: string }[]>`
          insert into public.notification_outbox (trading_day_id, recipient_type, recipient_company_id, template_key, payload, created_at)
          values (${dayId}, 'customer', ${companyId}, 'order_reminder', ${JSON.stringify({ tradeDate: date, lines: [] })}::jsonb, now() - interval '11 hours')
          returning id`)[0].id;
      const row = async (id: string) =>
        (await sql<Row[]>`select sent_at, attempt_count, last_error, next_attempt_at, claimed_at from public.notification_outbox where id = ${id}`)[0];
      const env = { SUPABASE_SERVICE_ROLE_KEY: key, ...LIVE };
      const run = (fetchImpl: typeof fetch) =>
        createDispatchHandler({ env: (n) => (env as Record<string, string>)[n], db: supabaseDispatchDb(dispatcherClient), fetch: fetchImpl, log: () => {} })(
          new Request("http://localhost/x", { method: "POST", headers: { authorization: `Bearer ${key}` } }),
        );

      // 1. Two overlapping runs: every message goes out exactly once.
      const groups = Array.from({ length: 6 }, (_, i) => `it-${tag}-${i}`);
      const ids: string[] = [];
      for (const g of groups) ids.push(await queue(await company(g)));
      const slow = fakeGreenApi(async () => {
        await new Promise((r) => setTimeout(r, 40));
        return new Response("{}");
      });
      const [a, b] = await Promise.all([run(slow.fetchImpl), run(slow.fetchImpl)]);
      assertEquals([a.status, b.status], [200, 200]);
      await a.body?.cancel();
      await b.body?.cancel();
      for (const g of groups) assertEquals(slow.sent.filter((s) => s.chatId === `${g}@g.us`).length, 1, `${g} sent once`);
      for (const id of ids) assert((await row(id)).sent_at !== null, `${id} marked sent`);

      // 2. A rejected token: no try counted, the row waits, the problem is shown.
      const failId = await queue(await company(`it-${tag}-fail`));
      const rejected = fakeGreenApi((chatId) => (chatId.startsWith(`it-${tag}-fail`) ? new Response("Unauthorized", { status: 401 }) : new Response("{}")));
      await (await run(rejected.fetchImpl)).body?.cancel();
      const afterReject = await row(failId);
      assertEquals(afterReject.attempt_count, 0);
      assertEquals(afterReject.claimed_at, null);
      assertMatch(afterReject.last_error ?? "", /401/);
      const [status] = await sql<{ channel_problem: string | null }[]>`select channel_problem from public.notification_dispatch_status`;
      assertMatch(status.channel_problem ?? "", /401/);

      // 3. A provider error: one try, a wait, and a quick second run leaves it alone.
      const busy = fakeGreenApi((chatId) => (chatId.startsWith(`it-${tag}-fail`) ? new Response("busy", { status: 503 }) : new Response("{}")));
      await (await run(busy.fetchImpl)).body?.cancel();
      const afterBusy = await row(failId);
      assertEquals(afterBusy.attempt_count, 1);
      assert(new Date(afterBusy.next_attempt_at!).getTime() > Date.now() + 60_000, "waits about 2 minutes");
      const quick = fakeGreenApi();
      await (await run(quick.fetchImpl)).body?.cancel();
      assertEquals(quick.sent.filter((s) => s.chatId.startsWith(`it-${tag}-fail`)).length, 0, "a quick nudge does not spend the next try");

      // 4. A network error that repeats the URL: the stored error has no token.
      await sql`update public.notification_outbox set next_attempt_at = null where id = ${failId}`;
      const leaky = fakeGreenApi((chatId, u) => {
        if (chatId.startsWith(`it-${tag}-fail`)) throw new TypeError(`error sending request for url (${u}): connection refused`);
        return new Response("{}");
      });
      await (await run(leaky.fetchImpl)).body?.cancel();
      const afterLeak = await row(failId);
      assertEquals(afterLeak.attempt_count, 2);
      assertFalse((afterLeak.last_error ?? "").includes(LIVE.WHATSAPP_LIVE_API_TOKEN), afterLeak.last_error ?? "");
      assertMatch(afterLeak.last_error ?? "", /waInstance\*\*\*/);
    } finally {
      if (companyIds.length) {
        await sql`delete from public.notification_outbox where recipient_company_id = any(${companyIds}::uuid[])`;
        await sql`delete from public.companies where id = any(${companyIds}::uuid[])`;
      }
      if (dayId) await sql`delete from public.trading_days where id = ${dayId}`;
      await sql`update public.notification_settings set whatsapp_enabled = ${wasEnabled}`;
      await sql`update public.notification_dispatch_status set channel_problem = null, channel_problem_since = null`;
      await sql.end();
    }
  },
});
