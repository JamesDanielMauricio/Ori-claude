import { queryOptions } from "@tanstack/react-query";

import type { DeliveryStatus } from "@/lib/delivery-labels";
import { createClient } from "@/lib/supabase/client";

// Reads behind the WhatsApp delivery screen (routes/backoffice/
// notification-deliveries.tsx). Both come from migration 0078 and are
// backoffice-only by row-level security: the view notification_deliveries
// reads through notification_outbox's own policy, and
// notification_dispatch_status has a backoffice-only policy of its own.

export interface DeliveryRow {
  id: string;
  trade_date: string | null;
  template_key: string;
  recipient_type: string;
  recipient_name: string | null;
  created_at: string;
  sent_at: string | null;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: string | null;
  delivered_count: number;
  status: DeliveryStatus;
}

export interface DispatchStatus {
  last_run_at: string | null;
  channel_problem: string | null;
  channel_problem_since: string | null;
}

// A week is enough to see anything still worth acting on: after 12 hours a
// message is no longer sent on its own.
const WINDOW_DAYS = 7;
const MAX_ROWS = 500;

export const deliveryQueries = {
  recent(scope: "unsent" | "all") {
    return queryOptions({
      queryKey: ["deliveries", "recent", scope],
      queryFn: async (): Promise<DeliveryRow[]> => {
        const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
        let query = createClient()
          .from("notification_deliveries")
          .select(
            "id, trade_date, template_key, recipient_type, recipient_name, created_at, sent_at, attempt_count, last_error, next_attempt_at, delivered_count, status",
          )
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(MAX_ROWS);
        if (scope === "unsent") query = query.not("status", "in", "(sent,skipped)");
        const { data, error } = await query;
        if (error) throw error;
        return data as DeliveryRow[];
      },
    });
  },

  dispatchStatus() {
    return queryOptions({
      queryKey: ["deliveries", "dispatch-status"],
      queryFn: async (): Promise<DispatchStatus | null> => {
        const { data, error } = await createClient()
          .from("notification_dispatch_status")
          .select("last_run_at, channel_problem, channel_problem_since")
          .maybeSingle();
        if (error) throw error;
        return data;
      },
    });
  },
};
