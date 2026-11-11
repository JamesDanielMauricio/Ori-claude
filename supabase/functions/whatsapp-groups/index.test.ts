// Tests for the WhatsApp group list, in Deno (the runtime it ships on).
//
// Run (from the repo root; DENO_NO_PACKAGE_JSON keeps Deno from reading —
// and rewriting — the pnpm workspace's package.json):
//   DENO_NO_PACKAGE_JSON=1 deno test supabase/functions/whatsapp-groups/
//
// With no permissions, on purpose: a fake sign-in, a fake environment and a
// fake Green API stand in for everything, so a test that reached the real
// network or read a real secret would fail instead of quietly doing it.

import { assert, assertEquals, assertFalse, assertMatch } from "jsr:@std/assert@1";

import { sendWhatsAppMessage } from "../whatsapp-dispatch/provider.ts";
import { CHANNEL_STATUSES, GREEN_API_BASE, groupsFromContacts, listWhatsAppGroups } from "./contacts.ts";
import { createGroupsHandler, type GroupsHandlerDeps, type IdentityDb, identityOnly } from "./handler.ts";

const SERVICE_KEY = "service-role-key-for-tests";
const LIVE = { WHATSAPP_ENV: "live", WHATSAPP_LIVE_ID_INSTANCE: "7103000001", WHATSAPP_LIVE_API_TOKEN: "live-secret-token-abc" };
const DEV = { WHATSAPP_DEV_ID_INSTANCE: "7103000002", WHATSAPP_DEV_API_TOKEN: "dev-secret-token-xyz" };
const SECRETS = [LIVE.WHATSAPP_LIVE_ID_INSTANCE, LIVE.WHATSAPP_LIVE_API_TOKEN, DEV.WHATSAPP_DEV_ID_INSTANCE, DEV.WHATSAPP_DEV_API_TOKEN];

const jwt = (claims: Record<string, unknown>) =>
  `${btoa(JSON.stringify({ alg: "HS256" }))}.${btoa(JSON.stringify(claims)).replace(/=+$/, "")}.sig`;
const ANON = jwt({ role: "anon" });
const SERVICE_JWT = jwt({ role: "service_role" });
const SESSION = {
  backoffice: "session-backoffice",
  customer: "session-customer",
  grower: "session-grower",
  noProfile: "session-no-profile",
  expired: "session-expired",
};

// A fake sign-in: the two identity calls, and a record of them.
class FakeIdentity implements IdentityDb {
  calls: string[] = [];
  authDown = false;
  userIdForToken(token: string) {
    this.calls.push("auth");
    if (this.authDown) return Promise.reject(new Error("auth unavailable"));
    const users: Record<string, string> = {
      [SESSION.backoffice]: "u-bo",
      [SESSION.customer]: "u-cust",
      [SESSION.grower]: "u-grow",
      [SESSION.noProfile]: "u-none",
    };
    return Promise.resolve(users[token] ?? null);
  }
  profileRole(userId: string) {
    this.calls.push("profile");
    const roles: Record<string, string> = { "u-bo": "backoffice", "u-cust": "customer", "u-grow": "grower" };
    return Promise.resolve(roles[userId] ?? null);
  }
}

// What getContacts answers for a number in a few groups, with the shapes a
// real list holds: people, groups with and without a name, a chat listed
// twice, an old-style group id, the status broadcast, and junk.
const CONTACTS: unknown[] = [
  { id: "972501234567@c.us", name: "ישראל ישראלי", contactName: "ישראל", type: "user" },
  { id: "120363000000000002@g.us", name: "תפוחים — הזמנות", type: "group" },
  { id: "120363000000000001@g.us", name: "", contactName: "אבוקדו", type: "group" },
  { id: "120363000000000003@g.us", type: "group" },
  { id: "120363000000000002@g.us", name: "שם כפול", type: "group" },
  { id: "972509999999-1600000000@g.us", name: "  בננות  ", type: "group" },
  { id: "status@broadcast", name: "Status" },
  { id: "@g.us", name: "no id at all" },
  { id: 120363000000000009, name: "an id that is not a string" },
  { name: "no id", type: "group" },
  null,
  "120363000000000010@g.us",
];
const EXPECTED = [
  { id: "120363000000000003", name: "120363000000000003" },
  { id: "120363000000000001", name: "אבוקדו" },
  { id: "972509999999-1600000000", name: "בננות" },
  { id: "120363000000000002", name: "תפוחים — הזמנות" },
];

// A fake Green API: records every call; `reply` decides each answer.
function fakeGreenApi(reply: (url: string) => Response | Promise<Response> = () => Response.json(CONTACTS)) {
  const calls: Array<{ url: string; method: string; signal: boolean }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", signal: init?.signal instanceof AbortSignal });
    return await reply(url);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function handlerWith(identity: IdentityDb, env: Record<string, string>, fetchImpl: typeof fetch, extra: Partial<GroupsHandlerDeps> = {}) {
  const vars: Record<string, string> = { SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ...env };
  const read: string[] = [];
  const lines: string[] = [];
  const handler = createGroupsHandler({
    env: (name) => {
      read.push(name);
      return vars[name];
    },
    db: identity,
    fetch: fetchImpl,
    log: (line) => lines.push(line),
    ...extra,
  });
  return { handler, read, lines };
}

const post = (token: string | null) =>
  new Request("http://localhost/whatsapp-groups", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: "{}",
  });

// ------------------------------------------------------------------ the list

Deno.test("keeps only groups: bare ids, a name on every row, each group once, in Hebrew order", async () => {
  assertEquals(groupsFromContacts(CONTACTS), EXPECTED);

  const api = fakeGreenApi();
  const { handler } = handlerWith(new FakeIdentity(), LIVE, api.fetchImpl);
  const res = await handler(post(SESSION.backoffice));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(await res.json(), { env: "live", groups: EXPECTED });
});

Deno.test("a chat listed twice keeps the first entry that has a name", () => {
  assertEquals(
    groupsFromContacts([
      { id: "1@g.us", name: "" },
      { id: "1@g.us", contactName: "שם מאוחר" },
      { id: "1@g.us", name: "עוד שם" },
    ]),
    [{ id: "1", name: "שם מאוחר" }],
  );
});

Deno.test("an answer that is not a list is 'unavailable'; a list with no groups is an empty list", async () => {
  for (const body of [{}, { contacts: CONTACTS }, "[]", 7, null]) assertEquals(groupsFromContacts(body), null, JSON.stringify(body));

  const replies: Array<[string, () => Response, number, string]> = [
    ["an object", () => Response.json({ error: "x" }), 502, "unavailable"],
    ["not JSON", () => new Response("<html>gateway</html>", { status: 200 }), 502, "unavailable"],
    ["people only", () => Response.json([{ id: "972501234567@c.us", name: "x" }]), 200, ""],
    ["empty", () => Response.json([]), 200, ""],
  ];
  for (const [name, reply, status, kind] of replies) {
    const { handler } = handlerWith(new FakeIdentity(), LIVE, fakeGreenApi(reply).fetchImpl);
    const res = await handler(post(SESSION.backoffice));
    assertEquals(res.status, status, name);
    const body = await res.json();
    if (kind) assertEquals(body.kind, kind, name);
    else assertEquals(body, { env: "live", groups: [] }, name);
  }
});

// ---------------------------------------------------------------- the provider

Deno.test("asks the dispatcher's own Green API host: a GET to getContacts, with a timeout", async () => {
  const api = fakeGreenApi();
  await listWhatsAppGroups(api.fetchImpl, { idInstance: "7103000001", apiToken: "tok-12345" });
  assertEquals(api.calls, [{ url: `${GREEN_API_BASE}/waInstance7103000001/getContacts/tok-12345`, method: "GET", signal: true }]);

  // The address the dispatcher's own send calls, so the two can't drift.
  const sent: string[] = [];
  await sendWhatsAppMessage(
    ((u: string) => {
      sent.push(String(u));
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch,
    { idInstance: "7103000001", apiToken: "tok-12345" },
    "972500000001",
    false,
    "x",
  );
  assertEquals(new URL(sent[0]).origin, new URL(GREEN_API_BASE).origin);
});

Deno.test("'the account, not the request' is the dispatcher's own set of statuses (every 4xx and 5xx)", async () => {
  const creds = { idInstance: "1", apiToken: "tok-12345" };
  const answer = (status: number) => (() => Promise.resolve(new Response("no", { status }))) as unknown as typeof fetch;
  for (let status = 400; status < 600; status++) {
    const dispatcher = await sendWhatsAppMessage(answer(status), creds, "972500000001", false, "x");
    const groups = await listWhatsAppGroups(answer(status), creds);
    assert(!dispatcher.ok && !groups.ok, `${status}`);
    assertEquals(groups.kind === "channel", dispatcher.kind === "channel", `${status}`);
    assertEquals(groups.kind === "channel", CHANNEL_STATUSES.has(status), `${status}`);
    if (groups.kind !== "channel") assertEquals(groups.kind, "unavailable", `${status}`);
  }
});

Deno.test("failure kinds: not configured (500), the account (502), anything that may pass (502)", async () => {
  const kindOf = async (env: Record<string, string>, reply: (url: string) => Response | Promise<Response>) => {
    const api = fakeGreenApi(reply);
    const res = await handlerWith(new FakeIdentity(), env, api.fetchImpl).handler(post(SESSION.backoffice));
    const body = await res.json();
    return { status: res.status, kind: body.kind, env: body.env, calls: api.calls.length };
  };

  const halfSet: Array<Record<string, string>> = [{}, { WHATSAPP_DEV_ID_INSTANCE: "7103000002" }, { WHATSAPP_DEV_API_TOKEN: "dev-secret-token-xyz" }];
  for (const env of halfSet) {
    assertEquals(await kindOf(env, () => Response.json(CONTACTS)), { status: 500, kind: "not_configured", env: "dev", calls: 0 });
  }
  // Live switched on with only the dev pair set is not configured either:
  // the list is never the wrong number's.
  assertEquals(await kindOf({ ...DEV, WHATSAPP_ENV: "live" }, () => Response.json(CONTACTS)), {
    status: 500,
    kind: "not_configured",
    env: "live",
    calls: 0,
  });
  for (const status of [401, 403, 466]) {
    assertEquals(await kindOf(LIVE, () => new Response("Unauthorized", { status })), { status: 502, kind: "channel", env: "live", calls: 1 }, `${status}`);
  }
  for (const status of [400, 404, 429, 500, 502, 503]) {
    assertEquals(await kindOf(LIVE, () => new Response("busy", { status })), { status: 502, kind: "unavailable", env: "live", calls: 1 }, `${status}`);
  }
  const network = await kindOf(LIVE, () => Promise.reject(new TypeError("connection reset")));
  assertEquals(network, { status: 502, kind: "unavailable", env: "live", calls: 1 });
  const timeout = await kindOf(LIVE, () => Promise.reject(new DOMException("Signal timed out.", "TimeoutError")));
  assertEquals(timeout, { status: 502, kind: "unavailable", env: "live", calls: 1 });
});

Deno.test("the token and the instance id never leave the function — not in an answer, not in a log line", async () => {
  const leaky: Array<(url: string) => Response | Promise<Response>> = [
    (url) => Promise.reject(new TypeError(`error sending request for url (${url}): connection refused`)),
    (url) => new Response(`Unauthorized: ${url} (token ${LIVE.WHATSAPP_LIVE_API_TOKEN})`, { status: 401 }),
    (url) => new Response(`upstream ${url} failed`, { status: 503 }),
    (url) => new Response(`not json ${url}`, { status: 200 }),
  ];
  for (const reply of leaky) {
    const { handler, lines } = handlerWith(new FakeIdentity(), LIVE, fakeGreenApi(reply).fetchImpl);
    const text = await (await handler(post(SESSION.backoffice))).text();
    for (const out of [text, ...lines]) {
      for (const secret of SECRETS) assertFalse(out.includes(secret), out);
    }
  }
  // …and the redacted address is still recognisable in the log.
  const { handler, lines } = handlerWith(new FakeIdentity(), LIVE, fakeGreenApi(leaky[0]).fetchImpl);
  await (await handler(post(SESSION.backoffice))).body?.cancel();
  assert(lines.some((line) => /waInstance\*\*\*\/getContacts\/\*\*\*/.test(line)), lines.join("\n"));

  // contacts.ts on its own, too — the handler's second pass is a safety net,
  // not the only one.
  const creds = { idInstance: LIVE.WHATSAPP_LIVE_ID_INSTANCE, apiToken: LIVE.WHATSAPP_LIVE_API_TOKEN };
  for (const reply of leaky) {
    const result = await listWhatsAppGroups(fakeGreenApi(reply).fetchImpl, creds);
    assert(!result.ok);
    for (const secret of SECRETS) assertFalse(result.error.includes(secret), result.error);
  }
});

// Any eight characters of a secret in a row: a piece left behind is a leak
// too, which includes(secret) alone would miss.
function leaksPartOf(text: string, secret: string, size = 8): boolean {
  for (let start = 0; start + size <= secret.length; start++) {
    if (text.includes(secret.slice(start, start + size))) return true;
  }
  return false;
}

Deno.test("no piece of the token survives a long error body, and a secret a URL escapes is redacted too", async () => {
  const token = "Zq7Xw9Kp2Lm4Nv6Bt8Rc1Yd3Fg5Hj0";
  // The body repeats the token across the 300th character, where the error
  // text is cut.
  const long = await listWhatsAppGroups(
    fakeGreenApi(() => new Response(`${"x".repeat(285)} token=${token} end`, { status: 503 })).fetchImpl,
    { idInstance: "7103000001", apiToken: token },
  );
  assert(!long.ok);
  assertFalse(leaksPartOf(long.error, token), long.error);

  // An instance id saved with a trailing space. A network error repeats the
  // address as the URL parser wrote it, the space as "%20".
  const network = await listWhatsAppGroups(
    fakeGreenApi((url) => Promise.reject(new TypeError(`error sending request for url (${new URL(url).href})`))).fetchImpl,
    { idInstance: "7103000001 ", apiToken: token },
  );
  assert(!network.ok);
  assertFalse(network.error.includes("7103000001"), network.error);
  assertFalse(leaksPartOf(network.error, token), network.error);
});

Deno.test("direction controls are taken out of a group's name, so it cannot be made to look like another", () => {
  assertEquals(
    groupsFromContacts([
      { id: "1@g.us", name: "‮תפוחים — הזמנות‬" },
      // Nothing but controls: no name at all, so the row shows its id.
      { id: "2@g.us", name: "⁦‏⁩" },
    ]),
    [
      { id: "2", name: "2" },
      { id: "1", name: "תפוחים — הזמנות" },
    ],
  );
});

// ------------------------------------------------------------- who may call

Deno.test("refused callers never reach Green API, or even the credentials", async () => {
  for (const [name, token, status] of [
    ["no token", null, 401],
    ["anon key", ANON, 403],
    ["customer session", SESSION.customer, 403],
    ["grower session", SESSION.grower, 403],
    ["signed in, no profile", SESSION.noProfile, 403],
    ["expired session", SESSION.expired, 401],
    ["the service-role key", SERVICE_KEY, 403],
    ["a service-role JWT", SERVICE_JWT, 403],
  ] as const) {
    const api = fakeGreenApi();
    const { handler, read, lines } = handlerWith(new FakeIdentity(), LIVE, api.fetchImpl);
    const res = await handler(post(token));
    assertEquals(res.status, status, name);
    assertEquals((await res.json()).kind, "refused", name);
    assertEquals(api.calls.length, 0, name);
    assertFalse(read.some((v) => v.startsWith("WHATSAPP_")), `${name}: ${read.join(",")}`);
    assertEquals(lines, [], name);
  }
});

Deno.test("if the caller cannot be checked, the call is refused (fails closed) as one that may pass", async () => {
  const identity = new FakeIdentity();
  identity.authDown = true;
  const api = fakeGreenApi();
  const res = await handlerWith(identity, LIVE, api.fetchImpl).handler(post(SESSION.backoffice));
  assertEquals(res.status, 503);
  assertEquals((await res.json()).kind, "unavailable");
  assertEquals(api.calls.length, 0);
});

Deno.test("the caller check reaches the sign-in and nothing else", async () => {
  const identity = new FakeIdentity();
  const db = identityOnly(identity);
  assertEquals(await db.userIdForToken(SESSION.backoffice), "u-bo");
  assertEquals(await db.profileRole("u-bo"), "backoffice");
  assertEquals(identity.calls, ["auth", "profile"]);
  for (const call of [
    () => db.settings(),
    () => db.claim("w", 25),
    () => db.resolve("r"),
    () => db.preview("r"),
    () => db.targetSent("r", "t"),
    () => db.settle("r", "w", "sent"),
    () => db.recordRun(true, null),
  ]) {
    const outcome = await call().then(() => "resolved", (error: Error) => error.message);
    assertMatch(outcome, /no access to the WhatsApp queue/);
  }
});

Deno.test("CORS preflight does no work; anything but POST is turned away", async () => {
  const identity = new FakeIdentity();
  const api = fakeGreenApi();
  const { handler, read } = handlerWith(identity, LIVE, api.fetchImpl);
  const preflight = await handler(new Request("http://localhost/x", { method: "OPTIONS" }));
  assertEquals(preflight.status, 200);
  assertEquals(preflight.headers.get("access-control-allow-origin"), "*");
  await preflight.body?.cancel();

  const get = await handler(new Request("http://localhost/x", { headers: { authorization: `Bearer ${SESSION.backoffice}` } }));
  assertEquals(get.status, 405);
  assertEquals(get.headers.get("allow"), "POST, OPTIONS");
  await get.body?.cancel();

  assertEquals(identity.calls, []);
  assertEquals(api.calls.length, 0);
  assertEquals(read, []);
});

// ------------------------------------------------------------- which number

Deno.test("the number that sends: exactly WHATSAPP_ENV=live lists the live number's groups, anything else the test number's", async () => {
  for (const [env, instance, expected] of [
    [{ ...LIVE, ...DEV }, "7103000001", "live"],
    [{ ...LIVE, ...DEV, WHATSAPP_ENV: "dev" }, "7103000002", "dev"],
    [{ ...LIVE, ...DEV, WHATSAPP_ENV: "LIVE" }, "7103000002", "dev"],
    [{ ...DEV }, "7103000002", "dev"],
  ] as const) {
    const api = fakeGreenApi();
    const { handler, lines } = handlerWith(new FakeIdentity(), env, api.fetchImpl);
    const res = await handler(post(SESSION.backoffice));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).env, expected);
    assertMatch(api.calls[0].url, new RegExp(`/waInstance${instance}/getContacts/`));
    assert(lines.some((line) => line.includes(`WHATSAPP_${expected.toUpperCase()}_*`)), lines.join("\n"));
  }
});
