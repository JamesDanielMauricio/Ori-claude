// The group list's logic, kept apart from Deno.serve and the Supabase client
// (index.ts wires those in) so index.test.ts can run every path against a
// fake sign-in and a fake Green API.
//
// One call, in order:
//   1. Who is calling? Only a signed-in backoffice user — the dispatcher's
//      own check (authorizeCaller), then the service-role key is refused as
//      well. Decided before any credential is read.
//   2. Which number? The dispatcher's own WHATSAPP_ENV and credentials
//      (selectWhatsAppEnv / credentialsFor), so the list is always the groups
//      of the number that actually sends.
//   3. Green API getContacts, groups only, bare ids (contacts.ts).
//   4. {env, groups} — or {error, kind} with an HTTP status, `kind` being what
//      the web app explains to the user (apps/web/src/lib/queries/
//      whatsapp-groups.ts reads the same four kinds).
//
// The caller check and the credential choice are imported from
// ../whatsapp-dispatch, not copied, so the two functions cannot disagree on
// who may call or on which number is "the" number. Those files are left
// exactly as they are: the dispatcher is deployed from them.

import { authorizeCaller, CORS_HEADERS, credentialsFor, type DispatchDb, selectWhatsAppEnv } from "../whatsapp-dispatch/handler.ts";
import { type GroupsFailureKind, listWhatsAppGroups, redactCredentials, type WhatsAppGroup } from "./contacts.ts";

// The two identity calls of the dispatcher's DispatchDb — all this function
// needs from the database (index.ts passes the dispatcher's own db.ts).
export type IdentityDb = Pick<DispatchDb, "userIdForToken" | "profileRole">;

export interface GroupsHandlerDeps {
  env: (name: string) => string | undefined;
  db: IdentityDb;
  fetch: typeof fetch;
  log?: (line: string) => void;
}

// "refused" is everyone authorizeCaller (or the service-role rule below)
// turns away.
export type GroupsErrorKind = GroupsFailureKind | "refused";

export interface GroupsAnswer {
  env: "live" | "dev";
  groups: WhatsAppGroup[];
}

export interface GroupsError {
  error: string;
  kind: GroupsErrorKind;
  env?: "live" | "dev";
}

// not_configured is this deployment's own fault (500); channel and
// unavailable are Green API's answer, passed on as a bad gateway (502).
export const STATUS_FOR: Record<GroupsFailureKind, number> = { not_configured: 500, channel: 502, unavailable: 502 };

const REFUSED = "only a signed-in office user can list the WhatsApp groups";

// authorizeCaller is typed for the dispatcher's whole DispatchDb but uses only
// its two identity calls. It is handed exactly those two; every other call
// fails, so this function can never read the settings or touch the queue —
// even if a later change to authorizeCaller tried to (its own try/catch then
// refuses the caller with a 503: it fails closed).
export function identityOnly(db: IdentityDb): DispatchDb {
  const notHere = () => Promise.reject(new Error("whatsapp-groups has no access to the WhatsApp queue"));
  return {
    userIdForToken: (token) => db.userIdForToken(token),
    profileRole: (userId) => db.profileRole(userId),
    settings: notHere,
    claim: notHere,
    resolve: notHere,
    preview: notHere,
    targetSent: notHere,
    settle: notHere,
    recordRun: notHere,
  };
}

export function createGroupsHandler(deps: GroupsHandlerDeps): (req: Request) => Promise<Response> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const identity = identityOnly(deps.db);
  const answer = (body: GroupsAnswer | GroupsError, status = 200) => Response.json(body, { status, headers: CORS_HEADERS });

  return async (req: Request): Promise<Response> => {
    // SECURITY (CORS): the dispatcher's CORS_HEADERS — any origin may call
    // and read the answer. ALLOWS the backoffice app's picker, a cross-origin
    // call the browser would otherwise block. The answer names the office's
    // WhatsApp groups, but CORS is not what keeps them in: a caller must send
    // a backoffice user's session token, which the browser keeps in the app's
    // own storage (not a cookie a page on another origin could make it send),
    // and the gateway (verify_jwt) and authorizeCaller check it on every POST.
    // The preflight itself does no work and carries no token: it PROTECTS
    // AGAINST a preflight reaching Green API.
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    if (req.method !== "POST") {
      return Response.json(
        { error: "only POST is accepted", kind: "unavailable" } satisfies GroupsError,
        { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } },
      );
    }

    const auth = await authorizeCaller(req, { env: deps.env, db: identity });
    if ("status" in auth) {
      // 503 is "could not check who is calling — try again", the only refusal
      // that may pass by itself.
      return answer(
        { error: auth.status === 403 ? REFUSED : auth.error, kind: auth.status === 503 ? "unavailable" : "refused" },
        auth.status,
      );
    }
    // SECURITY: the service-role key is refused here, although authorizeCaller
    // lets it through (the dispatcher's schedule needs it). ALLOWS only a
    // signed-in backoffice user — the person with the picker open, the one
    // caller this function exists for. PROTECTS AGAINST a scheduled job, a
    // database trigger or a script holding the key calling getContacts in a
    // loop: every call here is a Green API call on the number that sends the
    // messages, and nothing automated needs the list. It also keeps every call
    // tied to a person. (Someone with the key reads the database anyway; this
    // is about the WhatsApp account, not about secrecy.)
    if (auth.caller.kind !== "backoffice") return answer({ error: REFUSED, kind: "refused" }, 403);

    const whatsappEnv = selectWhatsAppEnv(deps.env);
    const credentials = credentialsFor(deps.env, whatsappEnv);
    // Server-side only: which credential pair, never the values.
    log(`[whatsapp-groups] active credential set: WHATSAPP_${whatsappEnv.toUpperCase()}_* (WHATSAPP_ENV); caller: ${auth.caller.kind}`);

    const result = await listWhatsAppGroups(deps.fetch, credentials);
    if (!result.ok) {
      // Already redacted in contacts.ts; once more here because this text
      // leaves the server.
      const error = redactCredentials(result.error, credentials);
      log(`[whatsapp-groups] could not list the groups (${result.kind}): ${error}`);
      return answer({ error, kind: result.kind, env: whatsappEnv }, STATUS_FOR[result.kind]);
    }
    log(`[whatsapp-groups] listed ${result.groups.length} group(s)`);
    return answer({ env: whatsappEnv, groups: result.groups });
  };
}
