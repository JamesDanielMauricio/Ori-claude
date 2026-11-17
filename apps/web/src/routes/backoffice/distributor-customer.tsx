import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { CustomerOrdersDialog } from "@/components/arrangement/customer-orders-dialog";
import { ExpandableEntityRow } from "@/components/reference-data/expandable-entity-row";
import {
  FamilyGroupedLines,
  type FamilyGroupedRow,
} from "@/components/reference-data/family-grouped-lines";
import { OrderReminderConfirmDialog } from "@/components/reference-data/order-reminder-confirm-dialog";
import { OversightToolbar } from "@/components/reference-data/oversight-toolbar";
import { TwoColumnRowList } from "@/components/reference-data/two-column-row-list";
import { StatusPill } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { QueryError } from "@/components/ui/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { groupLinesByFamily } from "@/lib/family-grouping";
import {
  CUSTOMER_FILTER_OPTIONS,
  customerOrderState,
  matchesFilter,
  progressCount,
  type CustomerOrderState,
  type StatusFilter,
} from "@/lib/oversight-status";
import {
  oversightQueries,
  type DailyOrderForDay,
  type OrderLineRow,
  type OversightCustomer,
} from "@/lib/queries/oversight";
import { useTradingDayView } from "@/lib/trading-day-view";
import { useSendOrderReminder } from "@/lib/use-send-order-reminder";

// Same grouping as distributor-grower.tsx (groupLinesByFamily), on the
// ordered quantity.
function orderLineQuantity(line: OrderLineRow): number {
  return Number(line.pallets_ordered) || 0;
}

// See distributor-grower.tsx's NO_FAMILIES.
const NO_FAMILIES: FamilyGroupedRow[] = [];

// Distributor-facing "Customer Order Status" oversight (PRD:
// backoffice.md's "distributor+customer" tab — "Distributor as Customer
// View": a shared view used when the Distributor needs to act on a
// customer's behalf). Same shape as distributor-grower.tsx, mirrored onto
// orders: a status-colored name per row, an expand chevron revealing that
// customer's order grouped by family (read-only), a pencil that opens
// CustomerOrdersDialog — the exact same OrderLinesEditor the customer's own
// screen and the arrangement board's pencil already use
// (get_orderable_catalog_for_customer and submit_order both accept "the
// owning customer, or backoffice") — and a bell that resends the order
// reminder.
//
// Replaced the same master-detail layout distributor-grower.tsx did, for
// the same reason: scanning who hasn't ordered yet used to be a one-
// customer-at-a-time question. See that file's own comment for the fuller
// rationale — it applies here unchanged.
export default function DistributorAsCustomerPage() {
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  // Not remembered: every visit starts on "all".
  const [filter, setFilter] = useState<StatusFilter<CustomerOrderState>>("all");
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [ordersDialogCustomer, setOrdersDialogCustomer] = useState<OversightCustomer | null>(null);

  // The day this oversight screen shows: the live open day by default, or —
  // once the sidebar's picker has pinned one (lib/trading-day-view.tsx) —
  // that specific date's day instead. `isLive` is what gates every write
  // control below, the same rule the arrangement board's popup follows.
  const dayView = useTradingDayView();
  const dayId = dayView.day?.id;

  const customersQuery = useQuery(oversightQueries.activeCustomers());

  // Orders AND their lines in one request (see oversightQueries.ordersForDay).
  const ordersForDayQueryKey = oversightQueries.ordersForDay(dayId).queryKey;

  const ordersForDayQuery = useQuery(oversightQueries.ordersForDay(dayId));

  const orderByCustomerId = useMemo(() => {
    const map = new Map<string, DailyOrderForDay>();
    for (const order of ordersForDayQuery.data ?? []) map.set(order.customer_company_id, order);
    return map;
  }, [ordersForDayQuery.data]);

  // Grouped once per read of the day's orders — see distributor-grower.tsx's
  // familiesByGrowerId.
  const familiesByCustomerId = useMemo(() => {
    const map = new Map<string, FamilyGroupedRow[]>();
    for (const order of ordersForDayQuery.data ?? []) {
      map.set(
        order.customer_company_id,
        groupLinesByFamily(order.daily_order_products, orderLineQuantity),
      );
    }
    return map;
  }, [ordersForDayQuery.data]);

  // Alphabetical once, here — both the single-column and two-column layouts
  // (TwoColumnRowList) read off this same order.
  const sortedCustomers = useMemo(() => {
    const rows = customersQuery.data ?? [];
    const needle = search.trim().toLocaleLowerCase("he");
    // Search AND status filter: a row must pass both.
    const filtered = rows.filter(
      (row) =>
        (!needle || row.name.toLocaleLowerCase("he").includes(needle)) &&
        matchesFilter(customerOrderState(orderByCustomerId.get(row.id) ?? null), filter),
    );
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name, "he"));
  }, [customersQuery.data, search, filter, orderByCustomerId]);

  // "X מתוך Y" over EVERY active customer, ignoring the search and the
  // filter. Hidden with no day, while the shop is not open yet, or when no
  // customer has an order.
  const counter = useMemo(() => {
    if (!dayId || dayView.day?.phase === "initiated") return null;
    const { done, total } = progressCount(
      (customersQuery.data ?? []).map((row) =>
        customerOrderState(orderByCustomerId.get(row.id) ?? null),
      ),
      ["submitted"],
    );
    return total === 0 ? null : { label: "הזמנות הוזנו", done, total };
  }, [dayId, dayView.day?.phase, customersQuery.data, orderByCustomerId]);

  // The bell asks "send <customer> a reminder?", and "שלח" there runs this
  // mutation with no list of people, so the server sends to the customer's
  // WhatsApp group, otherwise to each person with a usable phone — the same
  // as the סידור board (James, 2026-11-17). `variables` tells each row's bell
  // whether it is the one currently sending. The optimistic `reminder_sent_at`
  // patch and the toasts live in the hook, shared with other screens.
  const [reminderTarget, setReminderTarget] = useState<{
    dailyOrderId: string;
    customerName: string;
  } | null>(null);
  const reminderMutation = useSendOrderReminder({ ordersForDayQueryKey });

  function toggleExpanded(customerId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (!next.delete(customerId)) next.add(customerId);
      return next;
    });
  }

  // The day comes first: until it's known, `dayId` is undefined and the
  // screen would briefly claim there is no open trading day.
  const isLoading =
    dayView.isLoading || customersQuery.isLoading || (!!dayId && ordersForDayQuery.isLoading);

  const rows = sortedCustomers.map((customer) => {
    const order = orderByCustomerId.get(customer.id) ?? null;
    // Green ("done") once submitted, or once the trading day itself has
    // closed — orders have no "closed" status of their own (daily_orders
    // only ever holds 'open'/'submitted', see migration 0017), so a
    // customer who never submitted still turns green once the day is over
    // and nothing further can happen. Checked against the day's own
    // `phase`, not `dayView.isLive`: a pinned past date is "not live" but
    // its phase could in principle be anything (per James 2026-09-15, same
    // rule as distributor-grower.tsx's identical tone comment).
    const dayClosed = dayView.day?.phase === "closed";
    const tone =
      order?.status === "submitted" || dayClosed ? "accent" : !order ? "warning" : "neutral";
    const caption =
      order?.status === "submitted" && order.submitted_at
        ? `נשלח ב-${new Date(order.submitted_at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`
        : null;
    const families = familiesByCustomerId.get(customer.id) ?? NO_FAMILIES;
    const reminding =
      reminderMutation.isPending && reminderMutation.variables?.dailyOrderId === order?.id;

    return (
      <ExpandableEntityRow
        key={customer.id}
        name={customer.name}
        tone={tone}
        caption={caption}
        expanded={expandedIds.has(customer.id)}
        onToggle={() => toggleExpanded(customer.id)}
        onEdit={() => setOrdersDialogCustomer(customer)}
        editLabel={`ערוך את הזמנת ${customer.name}`}
        onRemind={() => {
          if (!order) return;
          setReminderTarget({ dailyOrderId: order.id, customerName: customer.name });
        }}
        remindLabel={`שלח תזכורת ל${customer.name}`}
        remindDisabled={
          !dayView.isLive || !order || order.status === "submitted" || reminderMutation.isPending
        }
        reminding={reminding}
      >
        {/* Bubble's הזמנות shows the comment on the whole order with its
            lines (migration 0093), so the office needn't open each order. */}
        {order?.comment && (
          <p className="mb-2 rounded-md bg-surface-muted px-3 py-2 text-sm text-ink ring-1 ring-inset ring-border">
            הערה כללית: {order.comment}
          </p>
        )}
        <FamilyGroupedLines families={families} emptyLabel="אין עדיין הזמנה עבור לקוח זה." />
      </ExpandableEntityRow>
    );
  });

  return (
    <>
      <PageHeader
        title="בשם לקוח"
        subtitle="צפייה ועריכה של הזמנות היום בשם כל לקוח, ושליחת תזכורות."
        actions={
          !dayView.isLive ? (
            <StatusPill tone="warning">צפייה בעבר — לא ניתן לערוך</StatusPill>
          ) : undefined
        }
      />

      <OversightToolbar
        search={search}
        onSearchChange={setSearch}
        searchLabel="חיפוש לקוח"
        searchPlaceholder="חיפוש לקוח…"
        filter={filter}
        onFilterChange={setFilter}
        filterOptions={CUSTOMER_FILTER_OPTIONS}
        counter={counter}
      />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : dayView.isLoadError ||
        (customersQuery.isError && customersQuery.data === undefined) ||
        (ordersForDayQuery.isError && ordersForDayQuery.data === undefined) ? (
        <QueryError
          what="לקוחות"
          onRetry={() => {
            void dayView.refetch();
            void customersQuery.refetch();
            void ordersForDayQuery.refetch();
          }}
          retrying={dayView.isFetching || customersQuery.isFetching || ordersForDayQuery.isFetching}
        />
      ) : !dayId ? (
        // Without a day, no customer has a `daily_orders` header — the
        // list below would otherwise render every row as "אין הזמנה" and
        // let its pencil open CustomerOrdersDialog with no real day for
        // OrderLinesEditor's catalog RPC to query against. Blocked here,
        // same message the original master-detail screen's detail pane
        // used, rather than letting a pencil discover the problem itself.
        <EmptyState
          icon="clock"
          title={dayView.isLive ? "אין יום מסחר פתוח" : "לא נמצא יום מסחר בתאריך זה"}
          hint={
            dayView.isLive
              ? "פתח יום עסקים בסרגל הצד כדי לנהל הזמנות בשם לקוחות."
              : "בחר תאריך אחר בסרגל הצד, או חזור ליום הפעיל."
          }
        />
      ) : dayView.day?.phase === "initiated" ? (
        // Same root cause as the !dayId branch above, one phase later: the
        // trading day is open but open_shop hasn't run yet, so it hasn't
        // bootstrapped a daily_orders header for anyone (see migration
        // 0031's open_shop — that insert is what creates them, and it only
        // runs on the initiated -> shop_open transition). Every customer
        // would otherwise render as `!order`, which the tone logic reads as
        // "warning" — not a real signal here, just "nobody can order yet",
        // so every name would show orange for a reason that has nothing to
        // do with any individual customer. Blocked here instead, same as
        // above, rather than showing a wall of false alarms.
        <EmptyState
          icon="cart"
          title="החנות עדיין לא נפתחה"
          hint="פתח את החנות בסרגל הצד כדי שלקוחות יוכלו להזמין, ולנהל הזמנות בשמם."
        />
      ) : rows.length === 0 ? (
        filter !== "all" ? (
          <EmptyState
            icon="briefcase"
            title="אין לקוחות בסטטוס הזה"
            hint={search ? "נסה מונח חיפוש או סטטוס אחר." : "בחר סטטוס אחר."}
          />
        ) : (
          <EmptyState
            icon="briefcase"
            title="אין לקוחות להצגה"
            hint={search ? "נסה מונח חיפוש אחר." : "אין לקוחות פעילים במערכת."}
          />
        )
      ) : (
        <TwoColumnRowList rows={rows} />
      )}

      {/* The bell's spinner shows the send, and the result arrives as a toast. */}
      <OrderReminderConfirmDialog
        target={reminderTarget}
        onClose={() => setReminderTarget(null)}
        onConfirm={(dailyOrderId) => reminderMutation.mutate({ dailyOrderId })}
      />

      <CustomerOrdersDialog
        tradingDayId={dayId ?? ""}
        customerId={ordersDialogCustomer?.id ?? null}
        customerName={ordersDialogCustomer?.name ?? ""}
        onClose={() => setOrdersDialogCustomer(null)}
        onSubmitted={() => {
          void queryClient.invalidateQueries({
            queryKey: oversightQueries.ordersForDay(dayId).queryKey,
          });
          setOrdersDialogCustomer(null);
        }}
        readOnly={!dayView.isLive}
      />
    </>
  );
}
