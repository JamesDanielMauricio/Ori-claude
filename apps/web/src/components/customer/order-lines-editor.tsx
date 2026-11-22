import {
  CUSTOMER_ERROR_CODES,
  submitOrderInputSchema,
  toSubmitOrderRpcArgs,
} from "@ori/domain/customer";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import { ActionBar } from "@/components/reference-data/action-bar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { QueryError } from "@/components/ui/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/error-message";
import { hasChanges } from "@/lib/has-changes";
import { optimisticUpdate } from "@/lib/optimistic-mutation";
import { customerQueries } from "@/lib/queries/customer";
import { tradingDayQueries } from "@/lib/queries/trading-day";
import { createClient } from "@/lib/supabase/client";
import { formatVarietyName } from "@/lib/variety-label";

import { CommentPopup } from "./comment-popup";
import {
  formatPrice,
  groupCatalogByFamily,
  groupCatalogForBrowsing,
  weekdayDateLabel,
  type CatalogRow,
} from "./catalog-grouping";
import {
  linesOverLimit,
  mergeServerRows,
  orderCommentChanged,
  orderCommentToSend,
  orderLimit,
  rememberRows,
  toDraft,
  toSubmittedLines,
  withVanishedTypedLines,
  type DraftLine,
} from "./order-draft";
import { OrderProductList, type OrderFamilyRow } from "./order-product-list";
import {
  clearPreferredGrower,
  initialGrowerChoice,
  readPreferredGrower,
  setPreferredGrower,
} from "./preferred-grower";
import { PreferredGrowerDialog } from "./preferred-grower-dialog";
import { SubmissionConfirmationDialog } from "./submission-confirmation-dialog";

// A customer's submit found the shop already closed — see submitMutation.
class ShopClosedError extends Error {
  constructor() {
    super("החנות נסגרה להזמנות.");
    this.name = "ShopClosedError";
  }
}

// The one place both the customer's own order screen and the
// distributor's Customer Order Status oversight screen
// (`/backoffice/distributor-customer`) browse the catalog and edit an
// order's lines — same rules either way (get_orderable_catalog_for_customer
// and submit_order both accept "the owning customer, or backoffice"), so
// one component covers both instead of two near-identical copies (R1/R5),
// same precedent as PickLinesEditor in the grower module.
//
// `customerCompanyId` omitted means "my own order" (the customer's own
// screen); supplied, it's the backoffice-on-behalf-of path — the RPC
// layer is what actually enforces who may pass it, not this component.
//
// Keyed by the order it edits, for every host at once: the draft is keyed
// by variety id, and variety ids are the same on every day, so an editor
// left mounted while its day changed (a phone locked overnight, then one
// refetch from yesterday's day to today's) re-applied yesterday's unsent
// lines to today's order as if typed there.
export function OrderLinesEditor(props: ComponentProps<typeof OrderLinesEditorBody>) {
  return (
    <OrderLinesEditorBody
      key={`${props.tradingDayId}:${props.customerCompanyId ?? ""}`}
      {...props}
    />
  );
}

function OrderLinesEditorBody({
  tradingDayId,
  customerCompanyId,
  onSubmitted,
  tradeDate,
  readOnly = false,
}: {
  tradingDayId: string;
  customerCompanyId?: string;
  onSubmitted?: () => void;
  // ISO date, e.g. trading_days.trade_date. Renders the reference design's
  // title + date-pill header inside the list card. Omitted on the
  // backoffice on-behalf-of screen (distributor-customer.tsx), which
  // already renders its own header (company name + order status) above
  // this component.
  tradeDate?: string;
  // The ONE switch between "this order can be changed" and "this order can
  // only be read" — there is deliberately no second, per-session "ערוך" gate
  // layered on top of it (this editor had one until now, and so did
  // PickLinesEditor, in the grower module). Two reasons it doesn't belong
  // here:
  //
  // A gate answers "does this person intend to edit?". But an order is only
  // ever editable when the shop is open, and when it is open, editing is the
  // entire purpose of the screen — the question the gate asked had one
  // answer, so it cost a click and a scroll to the bottom of a
  // several-hundred-row catalogue to say "yes" every single time. What
  // actually decides editability is a fact about the trading day, and the
  // hosts below read it: the customer's own screen from
  // `trading_days.phase === "shop_open"` (routes/customer/order.tsx), the
  // backoffice ones from whether the sidebar's date picker
  // (lib/trading-day-view.tsx) has pinned a day other than the live one.
  //
  // This editor has no status of its own to fall back on the way a pick does
  // (`daily_orders.status` is only ever "open"/"submitted"; it never locks),
  // which is why every host has to pass this rather than it being derivable
  // here. Without it, editing and submitting an order for a closed
  // historical day would render as fully live right up until the server
  // rejected the write.
  //
  // Read-only means inputs disabled, comments as plain text, and no
  // ActionBar at all — so a locked order shows no save button to press.
  readOnly?: boolean;
}) {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const editing = !readOnly;
  const [draft, setDraft] = useState<Record<string, DraftLine>>({});
  // The varieties this person has changed since the last send or discard —
  // see the re-seeding effect below.
  const editedIds = useRef<Set<string>>(new Set());
  // The last row seen for every product this screen has shown — what keeps a
  // typed line on screen after its product leaves the shop (orderRows below).
  const [knownRows, setKnownRows] = useState<ReadonlyMap<string, CatalogRow>>(() => new Map());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [commentPopupVarietyId, setCommentPopupVarietyId] = useState<string | null>(null);
  const [growerChooserVarietyId, setGrowerChooserVarietyId] = useState<string | null>(null);

  const catalogOptions = customerQueries.catalog(tradingDayId, customerCompanyId);
  const queryKey = catalogOptions.queryKey;

  const catalogQuery = useQuery(catalogOptions);

  // Workbook Task 36: the varieties two or more growers have in stock today,
  // with those growers' names — what the "מגדל מועדף" button offers (migration
  // 0095). Same host rules as the catalog, so בשם לקוח and the board's pencil
  // get it too. Read only while the order can be changed, the only time the
  // button shows. Nothing else here waits for it or depends on it: until it
  // arrives — and whenever it fails, above all before 0095 has run on the
  // database — the rows simply have no button, with no error shown and the
  // send unaffected.
  const growersQuery = useQuery({
    ...customerQueries.varietyGrowers(tradingDayId, customerCompanyId),
    enabled: editing,
  });
  const growersByVariety = editing ? growersQuery.data : undefined;

  // The comment on the whole order, "הערה כללית" (migration 0093). Its own
  // small read, so every host — the customer's screen, בשם לקוח and the
  // board's pencil — gets it without passing it in. Kept like the lines: a
  // refetch re-seeds it only while this person hasn't edited it.
  const commentOptions = customerQueries.orderComment(tradingDayId, customerCompanyId);
  const commentQueryKey = commentOptions.queryKey;
  const commentQuery = useQuery(commentOptions);
  // Loaded = the stored comment arrived at least once. Not isSuccess: a
  // failed re-read (a return to the tab, a live update) turns that false
  // while keeping the comment it had, which disabled the button and left an
  // edited comment out of the send without a word.
  const commentLoaded = commentQuery.data !== undefined;
  const [commentDraft, setCommentDraft] = useState("");
  const commentEdited = useRef(false);
  const [orderCommentOpen, setOrderCommentOpen] = useState(false);

  useEffect(() => {
    if (commentEdited.current) return;
    setCommentDraft(commentQuery.data?.comment ?? "");
  }, [commentQuery.data]);

  // Keeps the draft tracking the server without clobbering typing in
  // progress: every refetch re-seeds the lines this person has NOT edited
  // and keeps the ones they have (mergeServerRows). The live updates
  // (lib/live-updates.ts) refetch this query whenever anything on the day
  // changes — any grower's pick, any customer's order, every ✓ the
  // distributor presses on the arrangement board — which can land mid-way
  // through this customer's own typing. The whole draft used to freeze at
  // the first keystroke instead, and since a send replaces the whole order,
  // that frozen copy then deleted or reverted whatever the distributor
  // changed on the customer's behalf in the meantime.
  useEffect(() => {
    if (!catalogQuery.data) return;
    const rows = catalogQuery.data;
    setDraft((current) => mergeServerRows(current, rows, editedIds.current));
    setKnownRows((current) => rememberRows(current, rows));
  }, [catalogQuery.data]);

  // What every part of this editor reads — the list, the count, the
  // confirmation, the limit check and the send: the shop's rows plus any line
  // typed here whose product has since left the shop (withVanishedTypedLines).
  // All of them reading the same rows is what keeps such a line from being
  // shown in one place and silently left out of another.
  const orderRows = useMemo(
    () => withVanishedTypedLines(catalogQuery.data ?? [], draft, knownRows),
    [catalogQuery.data, draft, knownRows],
  );

  // The reference design's shop screen: a collapsed row per product
  // family, expanding to that family's varieties — matches
  // get_orderable_catalog_for_customer's own grouping (R6, see
  // 0018_customer-order-functions.sql), not a second, divergent one.
  //
  // groupCatalogForBrowsing, not groupCatalogByFamily directly: on a
  // catalog of hundreds of varieties, what this customer already ordered
  // has to be reachable without scrolling past everything they haven't
  // touched — see that function's own comment for why the split is keyed
  // off the server row, not `draft`.
  // The most a customer can have on each line (order-draft.ts's orderLimit)
  // is shown, and held to, only on the customer's own screen — it is a
  // promise to the person it constrains. Backoffice editing a customer's
  // order on their behalf (customerCompanyId supplied) may deliberately go
  // past the customer's own cap, same as submit_order never enforces it on
  // that path either (see 0042_customer-order-cap.sql).
  const showsLimit = !customerCompanyId;

  const families: OrderFamilyRow[] = useMemo(
    () =>
      groupCatalogForBrowsing(orderRows).map((family) => ({
        familyId: family.familyId,
        familyName: family.familyName,
        imageUrl: family.imageUrl,
        varieties: family.varieties.map((row) => {
          const comment = draft[row.variety_id]?.comment ?? "";
          const growers = growersByVariety?.get(row.variety_id) ?? [];
          const choosesGrower = growers.length >= 2;
          return {
            varietyId: row.variety_id,
            varietyName: formatVarietyName(row.variety_name, row.sizes),
            priceLabel: formatPrice(row),
            packType: row.pack_type,
            pallets: draft[row.variety_id]?.pallets ?? "",
            comment,
            outOfStock: !row.is_orderable,
            imageUrl: row.variety_image_url,
            ...(showsLimit ? { limit: orderLimit(row) } : {}),
            choosesGrower,
            // Read here, against the same growers the chooser offers, so the
            // row's "✓" and the chooser agree on what the comment names
            // (preferred-grower.ts). A string, so the memoized row still
            // receives only primitives.
            preferredGrower: choosesGrower ? readPreferredGrower(comment, growers) : null,
          };
        }),
      })),
    [orderRows, draft, showsLimit, growersByVariety],
  );

  // How many varieties this draft actually asks for. Shown in the pinned
  // action bar, which needs it twice over: a customer scrolling a
  // several-hundred-row catalogue has no other way to see how much of it
  // they've filled in without scrolling back through all of it, and the bar
  // itself is full-width — with only a button in it, it read as an empty
  // band rather than a designed footer.
  //
  // Deliberately a count of products and not a sum of quantities: pack_type
  // is per-variety (משטחים vs ארגזים, see OrderProductList), so one total
  // across a mixed order would be a number in no unit at all.
  const filledProductCount = useMemo(() => {
    let count = 0;
    for (const row of orderRows) {
      if (Number(draft[row.variety_id]?.pallets || 0) > 0) count += 1;
    }
    return count;
  }, [orderRows, draft]);

  const confirmFamilies = useMemo(() => {
    const nonzeroRows = orderRows
      .map((row) => ({
        ...row,
        pallets_ordered: Number(draft[row.variety_id]?.pallets || 0),
        comment: draft[row.variety_id]?.comment || null,
      }))
      .filter((row) => row.pallets_ordered > 0);
    return groupCatalogByFamily(nonzeroRows);
  }, [orderRows, draft]);

  // As with PickLinesEditor: the visible quantities are already the draft,
  // live as the customer types, so submitting doesn't change what's on
  // screen. What it does change is `dirty` (below) — derived from comparing
  // the draft against `catalogQuery.data` — which otherwise stays "unsaved"
  // until the round trip lands and this cache refetches. Patching the cache
  // here resolves that the instant "שמור" is pressed; a rejection rolls it
  // back, restoring `dirty` and the ActionBar along with it.
  const submitOptimistic = optimisticUpdate<CatalogRow[], void>(queryClient, queryKey, (rows) => {
    if (!rows) return rows;
    return rows.map((row) => {
      const line = draft[row.variety_id];
      return line
        ? { ...row, pallets_ordered: Number(line.pallets || 0), comment: line.comment || null }
        : row;
    });
  });
  // The order comment's own patch, for the same reason. Only once the stored
  // comment has loaded — before that nothing is sent for it, so nothing
  // changes.
  const commentOptimistic = optimisticUpdate<{ id: string; comment: string | null } | null, void>(
    queryClient,
    commentQueryKey,
    (current) =>
      current && commentLoaded ? { ...current, comment: commentDraft.trim() || null } : current,
  );

  const submitMutation = useMutation({
    mutationFn: async () => {
      // A customer's own order: confirm, right now, that the shop is still
      // open. The live updates (lib/live-updates.ts) tell this screen the
      // shop closed within about a second — but not on a device whose
      // connection has dropped, and not in that second. submit_order refuses
      // a customer's order once the shop is not open too (migration 0071), so
      // this check is what turns that into a clear message before anything is
      // sent; the server's refusal below covers the moment in between.
      // One ~1 KB read, only when someone actually submits. fetchQuery also
      // writes the answer into the shared open-day cache, which is what flips
      // the page to read-only (routes/customer/order.tsx) when it's closed.
      //
      // Not on the backoffice on-behalf-of path (customerCompanyId given):
      // staff may still edit a customer's order after the shop closes.
      if (!customerCompanyId) {
        const day = await queryClient.fetchQuery({ ...tradingDayQueries.open(), staleTime: 0 });
        if (day?.id !== tradingDayId || day.phase !== "shop_open") {
          throw new ShopClosedError();
        }
      }
      const lines = toSubmittedLines(orderRows, draft);
      const input = submitOrderInputSchema.parse({
        tradingDayId,
        lines,
        customerCompanyId,
        // Left out when the stored comment never loaded, so the save keeps it.
        comment: orderCommentToSend(commentLoaded, commentDraft),
      });
      const { data, error } = await supabase.rpc("submit_order", toSubmitOrderRpcArgs(input));
      if (error) {
        // The server's own answer to the same question as the check above
        // (migration 0071 refuses a customer's order once the shop is not
        // open): the shop closed in the moment between that check and this
        // send. Shown the same way, and the open-day cache refreshed so the
        // page turns read-only.
        if (!customerCompanyId && error.code === CUSTOMER_ERROR_CODES.INVALID_STATE) {
          void queryClient.invalidateQueries({ queryKey: tradingDayQueries.open().queryKey });
          throw new ShopClosedError();
        }
        throw error;
      }
      return data;
    },
    onMutate: async (variables) => {
      const lines = await submitOptimistic.onMutate(variables);
      const comment = await commentOptimistic.onMutate(variables);
      return { lines, comment };
    },
    onSuccess: () => {
      showToast("ההזמנה נשלחה.", "success");
      setConfirmOpen(false);
      // The draft now matches the server, so nothing is "edited" any more —
      // the refetch re-seeds every line, including the ones just sent, and
      // the order comment.
      editedIds.current = new Set();
      commentEdited.current = false;
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: commentQueryKey });
      onSubmitted?.();
    },
    onError: (
      error: { message?: string },
      variables,
      context:
        | {
            lines: { previous: CatalogRow[] | undefined } | undefined;
            comment: { previous: { id: string; comment: string | null } | null | undefined } | undefined;
          }
        | undefined,
    ) => {
      submitOptimistic.onError(error, variables, context?.lines);
      commentOptimistic.onError(error, variables, context?.comment);
      showToast(`השליחה נכשלה: ${errorMessage(error)}`, "error");
      // Closed on every failure, as PickLinesEditor's confirmation is: toasts
      // render below the browser's top layer, where the modal lives, so the
      // reason would sit unreadable behind its backdrop. Nothing is lost —
      // the draft stays, and "שמור" opens the review again. For a closed
      // shop there is also nothing left to confirm: the page is turning
      // read-only underneath.
      setConfirmOpen(false);
    },
  });

  // Stable (it touches only a ref and a state setter), so OrderProductList's
  // memoized rows re-render only when their own values change.
  const updateLine = useCallback((varietyId: string, patch: Partial<DraftLine>) => {
    editedIds.current.add(varietyId);
    setDraft((current) => ({
      ...current,
      [varietyId]: { pallets: "", comment: "", ...current[varietyId], ...patch },
    }));
  }, []);
  const changePallets = useCallback(
    (varietyId: string, value: string) => updateLine(varietyId, { pallets: value }),
    [updateLine],
  );

  // "מגדל מועדף" (workbook Task 36): the choice is written into the line's own
  // comment and nowhere else — "מגדל מועדף: <name>", kept beside whatever the
  // comment already says (preferred-grower.ts). So it is sent, saved and
  // shown as any line comment is: with the line's quantity, on "שמור", and
  // the customer may still change it by hand in "✎ הערה". Today's growers
  // go along: they are what tells the name already there apart from the
  // customer's own words typed after it. A choice that leaves the comment as
  // it was (the same grower again, or "ללא העדפה" with none chosen) is not an
  // edit.
  function chooseGrower(varietyId: string, growerName: string | null) {
    const current = draft[varietyId]?.comment ?? "";
    const growers = growersByVariety?.get(varietyId) ?? [];
    const next =
      growerName === null
        ? clearPreferredGrower(current, growers)
        : setPreferredGrower(current, growerName, growers);
    if (next !== current) updateLine(varietyId, { comment: next });
  }

  // The order with no unsaved edits — what "בטל שינויים" puts back, and what
  // the draft is measured against to decide whether either button has
  // anything to do.
  //
  // Worth more here than on the reference-data forms: a customer's order is
  // several hundred rows, so "did I actually change anything?" is not a
  // question they can answer by looking. And a no-op submit is not free —
  // submit_order re-stamps submitted_at and enqueues an order_submitted
  // notification to backoffice (migration 0031, id 6), so a reflexive press
  // of "שמור" tells the office an order changed when it did not.
  const baselineDraft = toDraft(catalogQuery.data ?? []);
  const dirty =
    hasChanges(toSubmittedLines(orderRows, draft), toSubmittedLines(orderRows, baselineDraft)) ||
    orderCommentChanged(commentQuery.data?.comment, commentDraft);

  function handleDiscard() {
    // Puts the fields back to the stored order, and nothing else — there is
    // no read-only mode for this button to drop into any more. Forgetting
    // the edited lines hands every line back to the re-seeding effect above.
    setDraft(baselineDraft);
    editedIds.current = new Set();
    setCommentDraft(commentQuery.data?.comment ?? "");
    commentEdited.current = false;
  }

  // "שמור" on the customer's own screen first checks every line against the
  // limit shown beside it. A line over it would have the server refuse the
  // whole send, losing every other change in it; the customer is told which
  // lines to lower instead, and the confirmation does not open.
  function handleSave() {
    if (showsLimit) {
      const over = linesOverLimit(orderRows, draft);
      if (over.length > 0) {
        const names = over.map((row) => formatVarietyName(row.variety_name, row.sizes)).join(", ");
        showToast(`הכמות גדולה מהמקסימום שאפשר להזמין כרגע: ${names}.`, "error");
        return;
      }
    }
    setConfirmOpen(true);
  }

  function handleConfirmSubmit() {
    setSubmitting(true);
    submitMutation.mutate(undefined, { onSettled: () => setSubmitting(false) });
  }

  if (catalogQuery.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  // "Nothing is available to order today" and "the catalog request failed"
  // rendered identically before, and the first is the one a customer acts on
  // — they close the tab. The catalog is the whole screen, so a failure here
  // has to say so.
  if (catalogQuery.isError && catalogQuery.data === undefined) {
    return (
      <QueryError
        what="קטלוג המוצרים"
        onRetry={() => void catalogQuery.refetch()}
        retrying={catalogQuery.isFetching}
      />
    );
  }

  if (families.length === 0) {
    return <p className="text-sm text-ink-muted">אין עדיין מוצרים זמינים להזמנה היום.</p>;
  }

  const activeComment = commentPopupVarietyId ? (draft[commentPopupVarietyId]?.comment ?? "") : "";
  // The row the "מגדל מועדף" chooser is open for, and what it offers.
  const chooserRow = growerChooserVarietyId
    ? orderRows.find((row) => row.variety_id === growerChooserVarietyId)
    : undefined;
  const chooserGrowers = growerChooserVarietyId
    ? (growersByVariety?.get(growerChooserVarietyId) ?? [])
    : [];
  const chooserLine = growerChooserVarietyId ? draft[growerChooserVarietyId] : undefined;

  return (
    <div className="flex flex-col gap-4">
      {/* Read-only (a closed day, history): the order comment as plain text,
          the way read-only line comments show. */}
      {readOnly && commentQuery.data?.comment && (
        <p className="rounded-lg bg-surface px-4 py-3 text-sm text-ink shadow-card ring-1 ring-inset ring-border/70">
          הערה כללית: {commentQuery.data.comment}
        </p>
      )}
      <div className="overflow-hidden rounded-xl bg-surface shadow-raised ring-1 ring-inset ring-border/70">
        {tradeDate && (
          <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-muted/60 px-5 py-4">
            <h2 className="text-sm font-semibold">הזמנת תוצרת</h2>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-xs font-medium text-ink-muted ring-1 ring-inset ring-border-strong">
              <Icon name="calendar" className="h-3.5 w-3.5" />
              {weekdayDateLabel(tradeDate)}
            </span>
          </div>
        )}
        <OrderProductList
          families={families}
          editable={editing}
          onChangePallets={changePallets}
          onOpenComment={setCommentPopupVarietyId}
          onChooseGrower={setGrowerChooserVarietyId}
        />
      </div>

      {!readOnly && (
        <ActionBar
          dirty={dirty}
          // Sticky on every host, the customer's own screen included: this
          // is exactly the "several hundred rows" case ActionBar's sticky
          // comment describes — "שמור" sitting under the whole catalogue
          // meant scrolling past all of it to commit a change made at the
          // top.
          sticky
          onDiscard={handleDiscard}
          onSave={handleSave}
          // `ms-auto` rather than a `justify-between` on the bar itself:
          // the buttons are ActionBar's own direct children, so spacing the
          // whole row would push them apart from each other too.
          extra={
            <>
              {/* Bubble's "הערה כללית": a comment on the whole order. Sent
                  with the order on "שמור", like the line comments. Disabled
                  until the stored comment has loaded, so nothing typed here
                  can be left unsent. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-10"
                disabled={!commentLoaded}
                onClick={() => setOrderCommentOpen(true)}
              >
                {commentDraft.trim() ? "✎ הערה כללית" : "+ הערה כללית"}
              </Button>
              <span className="ms-auto text-xs font-medium text-ink-muted">
                {filledProductCount === 0
                  ? "לא נבחרו מוצרים"
                  : `${filledProductCount === 1 ? "מוצר אחד" : `${filledProductCount} מוצרים`} בהזמנה`}
              </span>
            </>
          }
        />
      )}

      <CommentPopup
        open={orderCommentOpen}
        title="הערה כללית"
        initialValue={commentDraft}
        onClose={() => setOrderCommentOpen(false)}
        onConfirm={(comment) => {
          commentEdited.current = true;
          setCommentDraft(comment);
        }}
      />

      <CommentPopup
        open={commentPopupVarietyId !== null}
        initialValue={activeComment}
        onClose={() => setCommentPopupVarietyId(null)}
        onConfirm={(comment) => {
          if (commentPopupVarietyId) updateLine(commentPopupVarietyId, { comment });
        }}
      />

      <PreferredGrowerDialog
        // Closed, too, if the order stops being editable while it is open
        // (the shop closed meanwhile): there is no longer a choice to make.
        open={editing && growerChooserVarietyId !== null}
        varietyName={chooserRow ? formatVarietyName(chooserRow.variety_name, chooserRow.sizes) : ""}
        growers={chooserGrowers}
        initialChoice={initialGrowerChoice(chooserLine?.comment ?? "", chooserGrowers)}
        hasQuantity={Number(chooserLine?.pallets || 0) > 0}
        onClose={() => setGrowerChooserVarietyId(null)}
        onConfirm={(growerName) => {
          if (growerChooserVarietyId) chooseGrower(growerChooserVarietyId, growerName);
        }}
      />

      <SubmissionConfirmationDialog
        open={confirmOpen}
        families={confirmFamilies}
        orderComment={commentDraft.trim() || undefined}
        confirming={submitting}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirmSubmit}
      />
    </div>
  );
}
