import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, StatusPill } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { QueryError } from "@/components/ui/query-error";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { canSendAgain, DELIVERY_STATUS, RECIPIENT_TYPE_LABEL, templateLabel } from "@/lib/delivery-labels";
import { errorMessage } from "@/lib/error-message";
import { runWhatsAppDispatchNow } from "@/lib/nudge-whatsapp-dispatch";
import { deliveryQueries, type DeliveryRow } from "@/lib/queries/deliveries";
import { createClient } from "@/lib/supabase/client";

// "הודעות WhatsApp" — what happened to every WhatsApp message queued in the
// last week (release workbook task 16, ORI-020): sent, waiting, retrying,
// failed, expired (not sent within 12 hours, so no longer sent on its own) or
// skipped (its switch was off). Staff see why a message failed and can send
// it again once the cause is fixed; recipients who already got it are not
// sent it twice (the queue keeps who was reached). A red banner says when
// WhatsApp itself is not sending — a wrong token, for instance — in which
// case messages wait without using up their tries.
//
// Read-only except "send again" (retry_outbox_row, backoffice-only in the
// database). Refreshed by hand and after each "send again" — no polling.

// Hoisted: building an Intl formatter is the slow part of formatting.
const DATE_TIME = new Intl.DateTimeFormat("he-IL", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Jerusalem",
});
const TIME = new Intl.DateTimeFormat("he-IL", { timeStyle: "short", timeZone: "Asia/Jerusalem" });
// A trade date is a calendar date with no time of its own.
const DATE = new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeZone: "UTC" });

const SCOPE_OPTIONS = [
  { value: "unsent", label: "רק הודעות שלא נשלחו" },
  { value: "all", label: "כל ההודעות מהשבוע האחרון" },
];

export default function NotificationDeliveriesPage() {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [scope, setScope] = useState<"unsent" | "all">("unsent");

  const rowsQuery = useQuery(deliveryQueries.recent(scope));
  const statusQuery = useQuery(deliveryQueries.dispatchStatus());

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["deliveries"] });
  };

  const sendAgain = useMutation({
    mutationFn: async (row: DeliveryRow) => {
      const { error } = await supabase.rpc("retry_outbox_row", { p_outbox_id: row.id });
      if (error) throw error;
      // Start a run now rather than waiting for the next scheduled one; the
      // queue is read again once it is over (onSettled).
      await runWhatsAppDispatchNow(supabase);
    },
    onSuccess: () => {
      showToast("ההודעה הוחזרה לתור ונשלחת.", "success");
    },
    onError: (error: { message?: string }) => {
      showToast(`השליחה החוזרת נכשלה: ${errorMessage(error)}`, "error");
    },
    onSettled: refresh,
  });

  const status = statusQuery.data;
  const rows = rowsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="הודעות WhatsApp"
        subtitle="מה קרה לכל הודעת WhatsApp מהשבוע האחרון. הודעה שלא נשלחה תוך 12 שעות לא תישלח לבד — אפשר לשלוח אותה שוב מכאן."
        actions={
          <Button variant="secondary" onClick={refresh} disabled={rowsQuery.isFetching}>
            רענן
          </Button>
        }
      />

      {status?.channel_problem && (
        <Card className="ring-1 ring-inset ring-danger/40">
          <div className="flex flex-col gap-1.5" role="alert">
            <p className="font-semibold text-danger">WhatsApp לא שולח כרגע</p>
            <p className="break-words text-sm text-ink" dir="ltr">
              {status.channel_problem}
            </p>
            <p className="text-sm text-ink-muted">
              {status.channel_problem_since && <>מאז {DATE_TIME.format(new Date(status.channel_problem_since))}. </>}
              ההודעות ממתינות ולא מאבדות ניסיונות. אחרי תיקון ההגדרות הן יישלחו בהרצה הבאה, אם עברו פחות מ-12 שעות מאז
              שנוצרו.
            </p>
          </div>
        </Card>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <Select
            value={scope}
            onChange={(value) => setScope(value === "all" ? "all" : "unsent")}
            options={SCOPE_OPTIONS}
            aria-label="אילו הודעות להציג"
          />
          {status?.last_run_at && (
            <span className="text-xs text-ink-muted">שליחה אחרונה: {DATE_TIME.format(new Date(status.last_run_at))}</span>
          )}
        </div>

        {rowsQuery.isError ? (
          <div className="p-4">
            <QueryError what="ההודעות" onRetry={refresh} retrying={rowsQuery.isFetching} />
          </div>
        ) : rowsQuery.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-ink-muted">
            {scope === "unsent" ? "כל ההודעות מהשבוע האחרון נשלחו." : "אין הודעות מהשבוע האחרון."}
          </p>
        ) : (
          <TableContainer>
            <TableHeader>
              <tr>
                <TableHead>נוצרה</TableHead>
                <TableHead>הודעה</TableHead>
                <TableHead>נמען</TableHead>
                <TableHead>מצב</TableHead>
                <TableHead>ניסיונות</TableHead>
                <TableHead>שגיאה אחרונה</TableHead>
                <TableHead>
                  <span className="sr-only">פעולה</span>
                </TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const state = DELIVERY_STATUS[row.status];
                return (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {DATE_TIME.format(new Date(row.created_at))}
                    </TableCell>
                    <TableCell>
                      <p className="font-medium text-ink">{templateLabel(row.template_key, row.recipient_type)}</p>
                      {row.trade_date && (
                        <p className="text-xs text-ink-muted">
                          יום מסחר {DATE.format(new Date(`${row.trade_date}T00:00:00Z`))}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="text-ink">{row.recipient_name ?? "—"}</p>
                      <p className="text-xs text-ink-muted">
                        {RECIPIENT_TYPE_LABEL[row.recipient_type] ?? row.recipient_type}
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1" title={state.explain}>
                        <StatusPill tone={state.tone} dot>
                          {state.label}
                        </StatusPill>
                        {row.status === "retrying" && row.next_attempt_at && (
                          <span className="text-xs text-ink-muted">
                            ניסיון הבא ב-{TIME.format(new Date(row.next_attempt_at))}
                          </span>
                        )}
                        {row.status === "sent" && row.delivered_count > 1 && (
                          <span className="text-xs text-ink-muted">{row.delivered_count} נמענים</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{row.attempt_count} / 5</TableCell>
                    <TableCell>
                      {row.last_error ? (
                        <span
                          className="line-clamp-2 block max-w-xs break-words text-xs text-ink-muted"
                          title={row.last_error}
                          dir="ltr"
                        >
                          {row.last_error}
                        </span>
                      ) : (
                        <span className="text-ink-subtle">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {canSendAgain(row.status) ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={sendAgain.isPending}
                          onClick={() => sendAgain.mutate(row)}
                        >
                          שלח שוב
                        </Button>
                      ) : (
                        <span aria-hidden />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </TableContainer>
        )}
      </Card>
    </div>
  );
}
