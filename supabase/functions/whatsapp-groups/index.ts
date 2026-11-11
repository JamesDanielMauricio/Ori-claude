// The WhatsApp group list — the WhatsApp groups of the connected number, for
// the group picker on the Growers, Customers and Transporters screens
// (apps/web/src/components/reference-data/whatsapp-group-cell.tsx). It
// replaces typing a group id by hand, as the old Bubble app's "group IDs
// (whatsapp)" popup did. Read-only: it sends nothing and writes nothing.
//
// This file only wires things together; the logic is in:
//   - handler.ts  — who may call, which number, the answer and its errors;
//   - contacts.ts — the Green API call, keeping only groups, bare ids;
// and, imported from ../whatsapp-dispatch (left unchanged): authorizeCaller,
// selectWhatsAppEnv and credentialsFor (handler.ts), redactSecrets
// (provider.ts) and the identity calls (db.ts). index.test.ts tests them
// (`deno test`, see that file for the command).
//
// POST, no body → 200 {env: "live" | "dev", groups: [{id, name}]}, groups
// sorted by name, ids bare (no "@g.us" — the form companies.whatsapp_group_id
// stores). A failure → {error, kind} with kind "not_configured", "channel",
// "unavailable" or "refused" (see handler.ts).
//
// Who calls it: a signed-in backoffice user's browser, nobody else — not even
// the service-role key (see handler.ts). The gateway checks the token first
// (verify_jwt, pinned in supabase/config.toml).
//
// Secrets: none of its own. It reads the dispatcher's WHATSAPP_ENV and
// WHATSAPP_LIVE_* / WHATSAPP_DEV_* (_ID_INSTANCE, _API_TOKEN), which
// Supabase gives every function of the project, so it lists the groups of
// the number that actually sends. The token never leaves this function.
//
// Deploy (by hand, per project; no migration needed):
//   npx supabase functions deploy whatsapp-groups --project-ref <ref> --use-api
// The deploy bundles the ../whatsapp-dispatch files above as they are at that
// moment: after a change to any of them, deploy both functions.

import { createClient } from "npm:@supabase/supabase-js@2";

import { supabaseDispatchDb } from "../whatsapp-dispatch/db.ts";
import { createGroupsHandler } from "./handler.ts";

const client = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(
  createGroupsHandler({
    env: (name) => Deno.env.get(name),
    // Only its two identity calls are reachable from here (identityOnly in
    // handler.ts): checking the caller's session, and reading their role.
    db: supabaseDispatchDb(client),
    fetch: (input, init) => fetch(input, init),
  }),
);
