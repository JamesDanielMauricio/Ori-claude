import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Migration 0078 — a single row (the same `id boolean primary key, check (id)`
// trick as notification_settings) holding what the WhatsApp dispatcher last
// knew: when it last ran, and the WhatsApp-wide problem it last hit (a wrong
// token, no test phone…) with when that started. The staff delivery screen
// shows it as a banner. Written only through record_dispatch_run, which keeps
// the problem through runs that send nothing and clears it after the first
// run that delivers a message again.
export const notificationDispatchStatus = pgTable("notification_dispatch_status", {
  id: boolean("id").primaryKey().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  channelProblem: text("channel_problem"),
  channelProblemSince: timestamp("channel_problem_since", { withTimezone: true }),
});
