// The WhatsApp dispatcher — works notification_outbox (packages/db/
// migrations 0020 onwards) after the transaction that queued a message has
// committed (R4's external-system carve-out: no outbound HTTP call ever
// happens inside a business transaction, only here).
//
// This file only wires things together; the logic is in:
//   - handler.ts  — who may start a run, claiming, sending, settling, the
//                   dev/live split, the forceEnv override;
//   - provider.ts — the Green API call, failure kinds, removing secrets
//                   from errors;
//   - db.ts       — the database calls (service-role key);
//   - phone.ts    — the phone rule (for the dev test phone).
// index.test.ts tests them (`deno test`, see that file for the command).
//
// WhatsApp provider: Green API (https://green-api.com). sendMessage is a
// plain POST to https://api.green-api.com/waInstance{idInstance}/
// sendMessage/{apiToken} with a {chatId, message} JSON body.
//
// Dev/live: WHATSAPP_ENV selects the credential pair (WHATSAPP_DEV_* or
// WHATSAPP_LIVE_*); anything but exactly "live" is dev. Dev sends every
// message, once, to notification_settings.whatsapp_dev_override_phone
// (migrations 0045/0046) instead of its real recipients. A one-off manual
// verification call may send {"forceEnv": "live"} — accepted only with the
// service-role key.
//
// Who calls it: the safety-net schedule every 10 minutes (pg_cron + pg_net,
// migration 0047, with the service-role key from Vault), and the office's
// instant nudge after a reminder bell (apps/web/src/lib/
// nudge-whatsapp-dispatch.ts, a signed-in backoffice session). Nobody else —
// see authorizeCaller in handler.ts.
//
// Deploy (by hand, AFTER migration 0078 has run):
//   npx supabase functions deploy whatsapp-dispatch --project-ref <ref> --use-api

import { createClient } from "npm:@supabase/supabase-js@2";

import { supabaseDispatchDb } from "./db.ts";
import { createDispatchHandler } from "./handler.ts";

const client = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(
  createDispatchHandler({
    env: (name) => Deno.env.get(name),
    db: supabaseDispatchDb(client),
    fetch: (input, init) => fetch(input, init),
  }),
);
