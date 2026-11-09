import type { Database } from "@ori/db/supabase-types";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { NotificationChannel } from "./channel";

// The Node copy of the WhatsApp dispatcher's loop, for tests that drive the
// real queue functions against the real database: claim batch after batch
// (claim_outbox_rows) until the queue is empty, resolve each row into its
// recipients (resolve_outbox_dispatch), hand each message to the injected
// NotificationChannel, record each recipient reached
// (record_outbox_target_sent) and settle the row (settle_outbox_row) — the
// same calls, in the same order, as supabase/functions/whatsapp-dispatch/
// handler.ts. That file is the one that runs in production; Deno can't
// import this package and this package can't import that file, so the
// ~50-line loop exists twice. The rules themselves — who may take a row,
// when it is due, what a failure costs, the 12-hour window — live once, in
// the SQL functions of migration 0078, and are tested here.
//
// Not copied: the dev-environment preview, the caller check and the time
// budget (Deno-only; index.test.ts covers them).
export interface DrainDeps {
  client: SupabaseClient<Database>;
  channel: NotificationChannel;
  // How many rows to claim at once (the dispatcher uses 25).
  batchSize?: number;
  // A fixed run id for tests that want to look at claims; a fresh one per
  // call otherwise.
  workerId?: string;
}

export interface DrainRowResult {
  outboxId: string;
  status: "sent" | "failed" | "skipped_toggle_off";
  error?: string;
}

export interface DrainResult {
  processed: number;
  sent: number;
  failed: number;
  skippedTogglesOff: number;
  rows: DrainRowResult[];
}

type NotificationSettingsRow = Pick<
  Database["public"]["Tables"]["notification_settings"]["Row"],
  | "whatsapp_enabled"
  | "notify_growers_on_business_day_open"
  | "shop_open_whatsapp_enabled"
  | "close_arrangement_customer_whatsapp_enabled"
  | "close_arrangement_grower_whatsapp_enabled"
>;

// Same switches as handler.ts's isEligible: the master switch, plus the four
// templates with their own (migration 0049). close_arrangement_customer/
// grower match by prefix, so a test template named
// close_arrangement_customer_test_<uuid> follows the real one's switch.
function isEligible(templateKey: string, settings: NotificationSettingsRow): boolean {
  if (!settings.whatsapp_enabled) return false;
  if (templateKey.startsWith("close_arrangement_customer")) return settings.close_arrangement_customer_whatsapp_enabled;
  if (templateKey.startsWith("close_arrangement_grower")) return settings.close_arrangement_grower_whatsapp_enabled;
  if (templateKey === "shop_open") return settings.shop_open_whatsapp_enabled;
  if (templateKey === "business_day_open_grower") return settings.notify_growers_on_business_day_open;
  return true;
}

export async function drainNotificationOutbox(deps: DrainDeps): Promise<DrainResult> {
  const { client, channel } = deps;
  const worker = deps.workerId ?? crypto.randomUUID();

  const { data: settingsRow, error: settingsError } = await client
    .from("notification_settings")
    .select(
      "whatsapp_enabled, notify_growers_on_business_day_open, shop_open_whatsapp_enabled, close_arrangement_customer_whatsapp_enabled, close_arrangement_grower_whatsapp_enabled",
    )
    .single();
  if (settingsError) throw settingsError;
  const settings: NotificationSettingsRow = settingsRow;

  const result: DrainResult = { processed: 0, sent: 0, failed: 0, skippedTogglesOff: 0, rows: [] };
  const settle = async (rowId: string, outcome: "sent" | "failed" | "skipped", detail: string | null = null) => {
    const { error } = await client.rpc("settle_outbox_row", {
      p_outbox_id: rowId,
      p_worker: worker,
      p_outcome: outcome,
      p_detail: detail,
    });
    if (error) throw error;
  };

  // Batch after batch until the queue is empty, as handler.ts does (0079:
  // every message goes out right after it is queued). A batch that was not
  // full emptied the queue; 20 batches is the same guard as MAX_BATCHES.
  const batchSize = deps.batchSize ?? 25;
  for (let batch = 1; batch <= 20; batch++) {
    const { data: claimed, error: claimError } = await client.rpc("claim_outbox_rows", {
      p_worker: worker,
      p_limit: batchSize,
    });
    if (claimError) throw claimError;
    const rows = claimed ?? [];

    for (const row of rows) {
      result.processed += 1;

      if (!isEligible(row.template_key, settings)) {
        await settle(row.id, "skipped", `Skipped: WhatsApp was disabled for template "${row.template_key}" when dispatch ran`);
        result.skippedTogglesOff += 1;
        result.rows.push({ outboxId: row.id, status: "skipped_toggle_off" });
        continue;
      }

      const { data: targets, error: resolveError } = await client.rpc("resolve_outbox_dispatch", {
        p_outbox_id: row.id,
      });
      if (resolveError) {
        await settle(row.id, "failed", resolveError.message);
        result.failed += 1;
        result.rows.push({ outboxId: row.id, status: "failed", error: resolveError.message });
        continue;
      }

      // Per-recipient delivery (migration 0038): a recipient reached on an
      // earlier pass is skipped, and each one reached now is recorded at once.
      const alreadySent = new Set(row.sent_targets ?? []);
      const errors: string[] = [];
      for (const { target, is_group, message } of targets ?? []) {
        if (alreadySent.has(target)) continue;
        const sendResult = await channel.send({ to: target, isGroup: is_group, body: message });
        if (!sendResult.success) {
          errors.push(sendResult.error ?? `send to ${target} failed`);
          continue;
        }
        alreadySent.add(target);
        const { error: recordError } = await client.rpc("record_outbox_target_sent", {
          p_outbox_id: row.id,
          p_target: target,
          p_complete: false,
        });
        if (recordError) errors.push(recordError.message);
      }

      if (errors.length === 0) {
        // Judged after the loop: also true for a row whose recipients were all
        // reached earlier, and for one that resolved to nobody.
        await settle(row.id, "sent");
        result.sent += 1;
        result.rows.push({ outboxId: row.id, status: "sent" });
      } else {
        const combined = errors.join("; ");
        await settle(row.id, "failed", combined);
        result.failed += 1;
        result.rows.push({ outboxId: row.id, status: "failed", error: combined });
      }
    }

    if (rows.length < batchSize) break;
  }

  return result;
}
