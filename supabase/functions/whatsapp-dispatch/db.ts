// DispatchDb (handler.ts) on top of a Supabase client holding the
// service-role key — the dispatcher's only way into the database. Each call
// is one PostgREST request, so each is its own transaction; the queue's
// rules (who may take a row, when it is due, what a failure costs) live in
// the SQL functions of migration 0078, not here.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

import type { ClaimedRow, DispatchDb, DispatchTarget, NotificationSettingsRow, Outcome } from "./handler.ts";

function fail(error: { message: string }): never {
  throw new Error(error.message);
}

export function supabaseDispatchDb(client: SupabaseClient): DispatchDb {
  return {
    async userIdForToken(token: string): Promise<string | null> {
      // The Auth server checks the session itself — signature, expiry, and
      // that the user still exists.
      const { data, error } = await client.auth.getUser(token);
      if (error) {
        // "Not a valid session" is an answer; anything else (Auth down, a
        // network error) is not, and is thrown so the caller is refused with
        // "try again" rather than judged.
        if (error.status !== undefined && error.status >= 400 && error.status < 500) return null;
        throw new Error(error.message);
      }
      return data.user?.id ?? null;
    },
    async profileRole(userId: string): Promise<string | null> {
      const { data, error } = await client.from("profiles").select("role").eq("user_id", userId).maybeSingle();
      if (error) fail(error);
      return (data as { role?: string } | null)?.role ?? null;
    },
    async settings(): Promise<NotificationSettingsRow> {
      const { data, error } = await client
        .from("notification_settings")
        .select(
          "whatsapp_enabled, notify_growers_on_business_day_open, shop_open_whatsapp_enabled, close_arrangement_customer_whatsapp_enabled, close_arrangement_grower_whatsapp_enabled, whatsapp_dev_override_phone",
        )
        .single();
      if (error) fail(error);
      return data as NotificationSettingsRow;
    },
    async claim(worker: string, limit: number): Promise<ClaimedRow[]> {
      const { data, error } = await client.rpc("claim_outbox_rows", { p_worker: worker, p_limit: limit });
      if (error) fail(error);
      return (data ?? []) as ClaimedRow[];
    },
    async resolve(outboxId: string): Promise<DispatchTarget[]> {
      const { data, error } = await client.rpc("resolve_outbox_dispatch", { p_outbox_id: outboxId });
      if (error) fail(error);
      return (data ?? []) as DispatchTarget[];
    },
    async preview(outboxId: string): Promise<string> {
      const { data, error } = await client.rpc("resolve_outbox_preview", { p_outbox_id: outboxId });
      if (error) fail(error);
      return data as string;
    },
    async targetSent(outboxId: string, target: string): Promise<void> {
      const { error } = await client.rpc("record_outbox_target_sent", {
        p_outbox_id: outboxId,
        p_target: target,
        p_complete: false,
      });
      if (error) fail(error);
    },
    async settle(outboxId: string, worker: string, outcome: Outcome, detail?: string | null): Promise<void> {
      const { error } = await client.rpc("settle_outbox_row", {
        p_outbox_id: outboxId,
        p_worker: worker,
        p_outcome: outcome,
        p_detail: detail ?? null,
      });
      if (error) fail(error);
    },
    async recordRun(channelOk: boolean | null, problem: string | null): Promise<void> {
      const { error } = await client.rpc("record_dispatch_run", { p_channel_ok: channelOk, p_channel_problem: problem });
      if (error) fail(error);
    },
  };
}
