// The WhatsApp dispatcher's logic, kept apart from Deno.serve and the
// Supabase client (index.ts wires those in) so index.test.ts can run every
// path against a fake database and a fake Green API.
//
// One run, in order:
//   1. Who is calling? Only the service-role key (the 10-minute safety-net
//      schedule, migration 0047) and a signed-in backoffice user (the
//      office's instant "nudge", apps/web/src/lib/nudge-whatsapp-dispatch.ts)
//      may start a run — checked before any setting or queue row is read.
//   2. Claim a batch (claim_outbox_rows, migration 0078): rows no other run
//      holds, not sent, not skipped, not expired (12-hour rule), and past
//      their retry wait.
//   3. Send each row and settle it (settle_outbox_row): sent; failed (counts
//      a try, waits before the next); released (a WhatsApp-wide problem —
//      no try counted, and the run stops); skipped (its switch is off).
//      Recipients already delivered to (sent_targets) are never sent again.
//   4. Report the run (record_dispatch_run) for the staff screen.
//
// Which template, which recipients, and the message text all come from
// Postgres (resolve_outbox_dispatch / resolve_outbox_preview), tested there.

import { type GreenApiCredentials, redactSecrets, sendWhatsAppMessage } from "./provider.ts";
import { toWhatsAppPersonalNumber } from "./phone.ts";

export interface NotificationSettingsRow {
  whatsapp_enabled: boolean;
  notify_growers_on_business_day_open: boolean;
  shop_open_whatsapp_enabled: boolean;
  close_arrangement_customer_whatsapp_enabled: boolean;
  close_arrangement_grower_whatsapp_enabled: boolean;
  whatsapp_dev_override_phone: string | null;
}

export interface ClaimedRow {
  id: string;
  template_key: string;
  // Recipients delivered to on an earlier pass (migration 0038).
  sent_targets: string[] | null;
}

export interface DispatchTarget {
  target: string;
  is_group: boolean;
  message: string;
}

export type Outcome = "sent" | "failed" | "released" | "skipped";

// What the dispatcher needs from the database. index.ts implements it with
// the service-role Supabase client; every method throws on a database error.
export interface DispatchDb {
  // Identity — used only to decide whether the caller may start a run.
  userIdForToken(token: string): Promise<string | null>;
  profileRole(userId: string): Promise<string | null>;
  // The work.
  settings(): Promise<NotificationSettingsRow>;
  claim(worker: string, limit: number): Promise<ClaimedRow[]>;
  resolve(outboxId: string): Promise<DispatchTarget[]>;
  preview(outboxId: string): Promise<string>;
  targetSent(outboxId: string, target: string): Promise<void>;
  settle(outboxId: string, worker: string, outcome: Outcome, detail?: string | null): Promise<void>;
  recordRun(channelOk: boolean | null, problem: string | null): Promise<void>;
}

export interface HandlerDeps {
  env: (name: string) => string | undefined;
  db: DispatchDb;
  fetch: typeof fetch;
  now?: () => number;
  newWorkerId?: () => string;
  log?: (line: string) => void;
}

export interface RunSummary {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  released: number;
  channelProblem: string | null;
}

// Rows per run, and how long a run keeps starting new rows. A Supabase Edge
// run is cut off at ~150 s; stopping new work at 100 s leaves room for the
// row in flight, and the unstarted ones are handed back for the next run.
export const BATCH_SIZE = 25;
export const RUN_BUDGET_MS = 100_000;

// SECURITY (CORS): allows browser JavaScript on any origin to call this
// function and read its response. The backoffice app's instant nudge is a
// cross-origin call, and the browser blocks it without these headers. CORS is
// not what protects this function: it only limits what a browser lets a page
// read, and curl, pg_net or any server ignore it. Who may start a run is
// decided by the Supabase gateway's JWT check (verify_jwt) and by
// authorizeCaller() below, on every POST, so narrowing the origin would add
// no real protection. The allowed headers are the ones supabase-js's
// functions.invoke sends.
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// whatsapp_enabled is the master switch every template needs; four templates
// also have their own switch (migration 0049). close_arrangement_customer/
// grower match by prefix, so a test template like
// close_arrangement_customer_test_<uuid> follows the same switch.
export function isEligible(templateKey: string, settings: NotificationSettingsRow): boolean {
  if (!settings.whatsapp_enabled) return false;
  if (templateKey.startsWith("close_arrangement_customer")) return settings.close_arrangement_customer_whatsapp_enabled;
  if (templateKey.startsWith("close_arrangement_grower")) return settings.close_arrangement_grower_whatsapp_enabled;
  if (templateKey === "shop_open") return settings.shop_open_whatsapp_enabled;
  if (templateKey === "business_day_open_grower") return settings.notify_growers_on_business_day_open;
  return true;
}

// Exactly "live" opts in to the live number; anything else — unset, a typo —
// is dev, the safe direction to fail in.
export function selectWhatsAppEnv(env: (name: string) => string | undefined): "dev" | "live" {
  return env("WHATSAPP_ENV") === "live" ? "live" : "dev";
}

export function credentialsFor(env: (name: string) => string | undefined, whatsappEnv: "dev" | "live"): GreenApiCredentials {
  const prefix = whatsappEnv === "live" ? "WHATSAPP_LIVE" : "WHATSAPP_DEV";
  return {
    idInstance: env(`${prefix}_ID_INSTANCE`) ?? "",
    apiToken: env(`${prefix}_API_TOKEN`) ?? "",
  };
}

function bearerToken(req: Request): string {
  return (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

// A JWT's claims, read WITHOUT checking its signature. Used only to tell the
// service-role key and the anon key apart from a user's session; the
// signature itself is checked by the Supabase gateway (verify_jwt, pinned on
// in supabase/config.toml) before this code runs, and a user's session is
// re-checked with the Auth server below.
function unverifiedClaims(token: string): { role?: unknown } | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
    return JSON.parse(json) as { role?: unknown };
  } catch {
    return null;
  }
}

// Whether the request carries the service-role key, in either form a caller
// may hold it: the exact SUPABASE_SERVICE_ROLE_KEY this function is given,
// or a JWT whose `role` claim is "service_role" (trusted because the gateway
// verified its signature — a forged token never reaches this code).
function isServiceRole(token: string, serviceRoleKey: string): boolean {
  if (!token) return false;
  if (serviceRoleKey && token === serviceRoleKey) return true;
  return unverifiedClaims(token)?.role === "service_role";
}

export type Caller = { kind: "service" } | { kind: "backoffice"; userId: string };

// SECURITY: decides who may start a dispatch run, before any setting or
// queue row is read. ALLOWS the service-role key (the safety-net schedule)
// and a signed-in user whose profile role is backoffice (the office's
// nudge) — the user's session is checked with the Auth server itself, not
// just read. PROTECTS AGAINST everyone else who can pass the gateway's
// signature check: anyone with the public anon key, any signed-in customer
// or grower, and a signed-in account with no profile — each of whom could
// otherwise make the office's WhatsApp send at moments of their choosing,
// burn retries, or race the schedule (review finding ORI-019).
export async function authorizeCaller(
  req: Request,
  deps: Pick<HandlerDeps, "env" | "db">,
): Promise<{ caller: Caller } | { status: number; error: string }> {
  const token = bearerToken(req);
  if (!token) return { status: 401, error: "missing authorization" };
  if (isServiceRole(token, deps.env("SUPABASE_SERVICE_ROLE_KEY") ?? "")) return { caller: { kind: "service" } };
  if (unverifiedClaims(token)?.role === "anon") {
    return { status: 403, error: "only the office can start WhatsApp sending" };
  }
  let userId: string | null;
  let role: string | null;
  try {
    userId = await deps.db.userIdForToken(token);
    role = userId ? await deps.db.profileRole(userId) : null;
  } catch {
    // Could not check — refuse rather than guess.
    return { status: 503, error: "could not check who is calling — try again" };
  }
  if (!userId) return { status: 401, error: "the session is not valid" };
  if (role !== "backoffice") return { status: 403, error: "only the office can start WhatsApp sending" };
  return { caller: { kind: "backoffice", userId } };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createDispatchHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const newWorkerId = deps.newWorkerId ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((line: string) => console.log(line));

  return async (req: Request): Promise<Response> => {
    // SECURITY: answers the browser's CORS preflight without doing any work.
    // Allows the browser to go on and send the real POST. Protects against a
    // preflight starting a run: a preflight carries no Authorization header,
    // so the gateway passes it through unauthenticated.
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

    const auth = await authorizeCaller(req, deps);
    if ("status" in auth) return Response.json({ error: auth.error }, { status: auth.status, headers: CORS_HEADERS });

    let forcedEnv: "live" | undefined;
    try {
      const body = await req.json();
      if (body && typeof body === "object" && (body as { forceEnv?: unknown }).forceEnv === "live") forcedEnv = "live";
    } catch {
      // No body or not JSON — what the schedule and the nudge send.
    }

    // SECURITY: forcing live credentials is refused unless the request
    // carries the service-role key. It ALLOWS the manual go-live
    // verification call this override exists for (made by hand with that
    // key). It PROTECTS AGAINST anyone else — backoffice staff included —
    // switching a dev-mode project onto the live number and sending every
    // queued message to real customers and growers instead of the test phone.
    if (forcedEnv && auth.caller.kind !== "service") {
      return Response.json({ error: "forceEnv requires the service-role key" }, { status: 403, headers: CORS_HEADERS });
    }

    const whatsappEnv = forcedEnv ?? selectWhatsAppEnv(deps.env);
    const credentials = credentialsFor(deps.env, whatsappEnv);
    const clean = (text: string) => redactSecrets(text, credentials);
    // Server-side only: which credential pair this run used, never the values.
    log(`[whatsapp-dispatch] active credential set: WHATSAPP_${whatsappEnv.toUpperCase()}_* (${forcedEnv ? "forced via request body" : "WHATSAPP_ENV default"}); caller: ${auth.caller.kind}`);

    let settings: NotificationSettingsRow;
    let rows: ClaimedRow[];
    const worker = newWorkerId();
    try {
      settings = await deps.db.settings();
      rows = await deps.db.claim(worker, BATCH_SIZE);
    } catch (error) {
      return Response.json({ error: clean(messageOf(error)) }, { status: 500, headers: CORS_HEADERS });
    }

    const summary: RunSummary = { processed: rows.length, sent: 0, failed: 0, skipped: 0, released: 0, channelProblem: null };
    let delivered = false;

    const settle = async (rowId: string, outcome: Outcome, detail: string | null = null) => {
      try {
        await deps.db.settle(rowId, worker, outcome, detail === null ? null : clean(detail));
      } catch (error) {
        // The claim expires in 10 minutes and the row is worked again then.
        log(`[whatsapp-dispatch] could not settle ${rowId} as ${outcome}: ${clean(messageOf(error))}`);
      }
      summary[outcome] += 1;
    };
    const send = (target: string, isGroup: boolean, body: string) =>
      sendWhatsAppMessage(deps.fetch, credentials, target, isGroup, body);

    // Dev never messages a real person: every row goes, once, as a preview to
    // the test phone in notification_settings (migrations 0045/0046).
    const devPhone = whatsappEnv === "dev" ? toWhatsAppPersonalNumber(settings.whatsapp_dev_override_phone) : null;
    if (whatsappEnv === "dev") {
      log(`[whatsapp-dispatch] dev env — every row sends a preview to the test phone (configured: ${devPhone ? "yes" : "no"})`);
    }

    const started = now();
    let next = 0;
    for (; next < rows.length; next++) {
      if (summary.channelProblem || now() - started > RUN_BUDGET_MS) break;
      const row = rows[next];

      if (!isEligible(row.template_key, settings)) {
        // Abandoned now, not just passed over (migration 0048): a switch
        // that is off means this message never goes out, even if the switch
        // is turned back on later.
        await settle(row.id, "skipped", `Skipped: WhatsApp was disabled for template "${row.template_key}" when dispatch ran`);
        continue;
      }

      if (whatsappEnv === "dev") {
        if (!devPhone) {
          summary.channelProblem = settings.whatsapp_dev_override_phone
            ? "the dev test phone (notification_settings.whatsapp_dev_override_phone) is not a phone number WhatsApp can reach — refusing to send in dev"
            : "the dev test phone (notification_settings.whatsapp_dev_override_phone) is not set — refusing to send in dev";
          await settle(row.id, "released", summary.channelProblem);
          continue;
        }
        let preview: string;
        try {
          preview = await deps.db.preview(row.id);
        } catch (error) {
          await settle(row.id, "failed", messageOf(error));
          continue;
        }
        const result = await send(devPhone, false, preview);
        if (result.ok) {
          delivered = true;
          await settle(row.id, "sent");
        } else if (result.kind === "channel") {
          summary.channelProblem = result.error;
          await settle(row.id, "released", result.error);
        } else {
          await settle(row.id, "failed", result.error);
        }
        continue;
      }

      let targets: DispatchTarget[];
      try {
        targets = await deps.db.resolve(row.id);
      } catch (error) {
        await settle(row.id, "failed", messageOf(error));
        continue;
      }

      // Per-recipient delivery (migration 0038): each recipient is recorded
      // the moment it is sent, so a later pass only sends to the ones still
      // missing.
      const alreadySent = new Set(row.sent_targets ?? []);
      const errors: string[] = [];
      for (const { target, is_group, message } of targets) {
        if (alreadySent.has(target)) continue;
        const result = await send(target, is_group, message);
        if (!result.ok) {
          if (result.kind === "channel") {
            summary.channelProblem = result.error;
            break;
          }
          errors.push(result.error);
          continue;
        }
        delivered = true;
        alreadySent.add(target);
        try {
          await deps.db.targetSent(row.id, target);
        } catch (error) {
          errors.push(clean(messageOf(error)));
        }
      }

      if (summary.channelProblem) {
        // Recipients reached before the problem stay recorded; the row waits,
        // with no try counted, and the run stops below.
        await settle(row.id, "released", summary.channelProblem);
      } else if (errors.length === 0) {
        // Judged once, after the loop: "nothing failed" — also true for a row
        // whose recipients were all reached earlier, and for one that resolved
        // to nobody (no group id and no usable phone number on file).
        await settle(row.id, "sent");
      } else {
        await settle(row.id, "failed", errors.join("; "));
      }
    }

    // Claimed but not started — because of a WhatsApp-wide problem or the time
    // budget: handed back with no try counted, for the next run.
    for (; next < rows.length; next++) {
      await settle(rows[next].id, "released", summary.channelProblem);
    }

    try {
      await deps.db.recordRun(summary.channelProblem ? false : delivered ? true : null, summary.channelProblem);
    } catch (error) {
      log(`[whatsapp-dispatch] could not record the run: ${clean(messageOf(error))}`);
    }

    return Response.json(summary, { headers: CORS_HEADERS });
  };
}
