import {
  ARRANGEMENT_ERROR_CODES,
  saveArrangementChangesInputSchema,
  toSaveArrangementChangesRpcArgs,
} from "@ori/domain/arrangement";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import {
  ArrangementMatrix,
  type MatrixWrite,
} from "@/components/arrangement/arrangement-matrix";
import { ArrangementMatrixMobile } from "@/components/arrangement/arrangement-matrix-mobile";
import { proposeForDay } from "@/components/arrangement/arrangement-engine-input";
import { readEngineHistory } from "@/components/arrangement/arrangement-history-query";
import {
  dropCells,
  pruneSaved,
  refusedCells,
  resolveProposal,
  saveRefusalMessage,
  typeIntoUnsaved,
  type ProposalLine,
} from "@/components/arrangement/arrangement-proposal";
import { formatPallets } from "@/components/arrangement/board-data";
import {
  buildMatrix,
  filterMatrixRows,
  orderedOnly,
  type ProposedAllocation,
} from "@/components/arrangement/matrix-data";
import { EMPTY_UNSAVED_DAY, useUnsavedChanges } from "@/components/arrangement/unsaved-changes";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { PageHeader } from "@/components/ui/page-header";
import { QueryError } from "@/components/ui/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/error-message";
import {
  arrangementKeys,
  arrangementQueries,
  newArrangementKeys,
  type MatrixDay,
} from "@/lib/queries/arrangement";
import { createClient } from "@/lib/supabase/client";
import { useTradingDayView } from "@/lib/trading-day-view";
import { useWide } from "@/lib/use-wide";

// One key for the save of the grid's unsaved changes, so "is one running?"
// can be asked of the mutation cache from any mount of this screen — see
// savingChanges.
const SAVE_CHANGES_KEY = ["new-arrangement", "save-changes"] as const;

// "סידור לפי מוצרים" — the day's whole arrangement as one spreadsheet:
// products down the side, customers across the top, and the pallets going
// from one to the other where they cross.
//
// This replaced a six-field wizard that built arrangement records one at a
// time (variety → grower → customer → quantity → price → save). The wizard
// was not wrong, it was just the wrong unit of work: a distributor settling a
// day is not creating a record, they are working across a customer's whole
// column or down a product's whole row, and doing that through a form meant
// re-selecting the variety and the grower for every single pallet decision.
// The matrix makes the same decision — one arrangement record, one grower's
// lot to one customer — the cost of typing a number, and the day's numbers
// are then saved together (see below).
//
// Two row shapes, which is the part worth understanding before reading
// matrix-data.ts: a product supplied by ONE grower is typed into directly,
// while a product supplied by SEVERAL opens to reveal a row per grower and
// shows only a read-only sum itself. An arrangement record points at a
// specific daily_pick_products row, so "3 pallets of lemons" is not a
// writable fact until it says whose lemons.
//
// Nothing is written while typing. A number typed into a cell, a cell
// emptied, a suggestion from "הצע סידור" — each is an unsaved change, drawn
// as one and kept above this screen (unsaved-changes.tsx), until "שמור
// שינויים" saves every change of the day in ONE call: save_arrangement_changes
// (migration 0103), all or nothing, refusing — rather than overwriting — a
// cell that somebody changed since it was changed here. Inside it each cell
// still goes through arrange_to_customer, the RPC the arrangement board's ✓
// uses, which creates the customer's order line at zero pallets when they
// never ordered the product — what makes the un-highlighted cells in this
// grid writable at all — and an emptied one through delete_arrangement_record.
export default function NewArrangementPage() {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [search, setSearch] = useState("");
  // "הצג רק מוזמנים": the grid cut down to the products someone ordered and
  // the customers who ordered — see orderedOnly. Off on arrival: the whole
  // day is what this screen opens on, and stock nobody has asked for is
  // where a push comes from.
  const [onlyOrdered, setOnlyOrdered] = useState(false);
  // Which multi-grower products are open. Product ids, not row indices, so
  // the set survives a refetch reordering or a search narrowing the list.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // Same `lg` threshold the arrangement board and the reference-data
  // two-column layout already switch on — see lib/use-wide.ts. Below it,
  // ArrangementMatrixMobile replaces the frozen-pane spreadsheet with a
  // drill-down card list; the underlying `visible` data (below) is identical
  // either way.
  const wide = useWide("(min-width: 1024px)");
  // The unsaved changes — numbers typed, cells emptied, suggestions from "הצע
  // סידור" — held as lines (whose lot, which product, which customer) rather
  // than as the cells they land in, and per trading day: so the cells are
  // worked out afresh from every read of that day (see `proposal` below), and
  // a change made on one day can never be shown, or saved, on another. They
  // live in the backoffice layout, above this screen, so leaving the grid and
  // coming back finds them; unsaved-changes.tsx says what empties them.
  const { dayOf, updateDay } = useUnsavedChanges();
  // "הצע סידור" is reading the history and working the proposal out.
  const [proposing, setProposing] = useState(false);
  // "בטל שינויים" is asking before it throws the unsaved changes away.
  const [discarding, setDiscarding] = useState(false);
  // Asked of the mutation cache, not of this component's own state: a save
  // outlives the screen that started it, and a distributor who leaves and
  // comes straight back must find the grid still held, not editable
  // underneath a save that is still landing.
  const savingChanges = useIsMutating({ mutationKey: SAVE_CHANGES_KEY }) > 0;

  // The day this grid shows: the live open day, or whatever the sidebar's
  // picker has pinned. Same resolution every date-aware backoffice screen
  // uses, sharing one query rather than each deciding for itself.
  const dayView = useTradingDayView();
  const day = dayView.day;

  // Everything else in ONE request once the day is known — see
  // arrangementQueries.matrix, which also carries what the arrangement
  // engine ranks orders by (when each was first submitted).
  const boardDataQueryKey = arrangementQueries.matrix(day?.id ?? null).queryKey;

  const boardDataQuery = useQuery(arrangementQueries.matrix(day?.id ?? null));

  // Whole-table reference data with no dependency on the day, so it starts
  // immediately and resolves in parallel instead of adding a round trip —
  // the same cache entry the arrangement board reads.
  const companiesQuery = useQuery(arrangementQueries.companies());

  const boardDay = boardDataQuery.data ?? null;
  const arrangement = boardDay?.daily_arrangements ?? null;
  // Same rule as the board: a pinned past day is read-only regardless of its
  // phase, and a closed arrangement is read-only regardless of the picker.
  const editable = dayView.isLive && arrangement?.status === "open";

  // This day's unsaved changes. A day with none, or still loading, reads as
  // EMPTY_UNSAVED_DAY.
  const unsaved = boardDay ? dayOf(boardDay.id) : EMPTY_UNSAVED_DAY;

  // The unsaved changes landed on the day as last read. Derived, not stored:
  // the day is re-read after a save and whenever anyone else changes it
  // (lib/live-updates.ts): a suggestion has to drop out the moment its cell
  // is filled rather than be shown — and counted — twice, and a change whose
  // cell already holds its number has nothing left to save. No read drops a
  // number typed: the save judges it (see resolveProposal). Nothing is
  // unsaved on a day that cannot be edited.
  const proposal = useMemo(
    () =>
      boardDay && editable && unsaved.lines.length > 0
        ? resolveProposal({
            lines: unsaved.lines,
            picks: boardDay.daily_picks,
            orders: boardDay.daily_orders,
            records: arrangement?.arrangement_records ?? [],
          })
        : null,
    [boardDay, arrangement, editable, unsaved.lines],
  );

  // What the distributor sees as unsaved: the cells "שמור שינויים" will
  // change, on the day as last read. Never the lines in the store, some of
  // which may land nowhere (see resolveProposal) and so show, and save,
  // nothing. The bar's count, and what holds "הצע סידור" back.
  const unsavedCount = proposal?.allocations.length ?? 0;

  // A day that can no longer be edited — its arrangement closed, say — has
  // nothing to save into, and loses its unsaved changes (spec §4.4), the bar
  // and the unsaved marks with them. Not while they are being saved, though:
  // the save decides what becomes of them then. An effect, not a render-time
  // update: the store lives in a parent component, and React warns against
  // updating one component while rendering another.
  const hasUnsaved = unsaved.lines.length > 0 || unsaved.refusal !== null;
  useEffect(() => {
    if (boardDay && !editable && !savingChanges && hasUnsaved) {
      updateDay(boardDay.id, () => EMPTY_UNSAVED_DAY);
    }
  }, [boardDay, editable, savingChanges, hasUnsaved, updateDay]);

  // One derivation for the whole grid, memoised on the query results only —
  // so typing in a cell, expanding a row or searching does not re-total the
  // day. On a ~600-line day that pass is the one genuinely expensive thing
  // this screen does.
  const matrix = useMemo(
    () =>
      buildMatrix({
        picks: boardDay?.daily_picks ?? [],
        orders: boardDay?.daily_orders ?? [],
        records: arrangement?.arrangement_records ?? [],
        companies: companiesQuery.data ?? [],
        proposal: proposal?.allocations ?? [],
      }),
    [boardDay, arrangement, companiesQuery.data, proposal],
  );

  // Filtering is separate from building for the same reason `markSelected` is
  // separate from `buildBoard` next door: a keystroke in the search box must
  // re-filter a list, not re-derive the day.
  //
  // Cut first, search second: which customers ordered is a fact about the
  // day, so the columns stay put while a product name is typed — and the cut
  // is not redone for every keystroke either.
  const shown = useMemo(() => (onlyOrdered ? orderedOnly(matrix) : matrix), [matrix, onlyOrdered]);
  const visible = useMemo(
    () => ({ columns: shown.columns, rows: filterMatrixRows(shown.rows, search) }),
    [shown, search],
  );

  /**
   * One cell, committed — into the unsaved changes. Nothing is written to the
   * database here, whatever the cell held: the number becomes the cell's
   * unsaved change (typed over what the day as read has saved there, see
   * typeIntoUnsaved), replaces the one it had, or — typed back to the saved
   * number — takes it away. Every change waits for "שמור שינויים", which
   * saves them all through save_arrangement_changes (0103).
   *
   * Silent, as filling a row should be: a distributor types across a dozen
   * cells in a few seconds, and the confirmation is already on screen — the
   * box drawn as unsaved, the bar's count, the זמין and סה״כ חולק columns
   * moving beside the number just typed.
   *
   * Resolves to whether the number was taken, never rejects: the phone list
   * puts its box back on false. Only a cell whose lot cannot be named is
   * refused — a pick line no longer on the day, or one whose product did not
   * come back: it has no row to have been typed into (see lotOfPickLine).
   */
  const commitCell = async (write: MatrixWrite): Promise<boolean> => {
    if (!boardDay) return false;
    const rows = {
      picks: boardDay.daily_picks,
      orders: boardDay.daily_orders,
      records: arrangement?.arrangement_records ?? [],
    };
    // Where the number goes does not depend on the lines, only on the cell.
    if (!typeIntoUnsaved(unsaved.lines, rows, write)) return false;
    // Applied to the lines as they stand when the update runs, not as they
    // were when the cell was drawn: two quick commits must both land.
    updateDay(boardDay.id, (current) => ({
      ...current,
      lines: typeIntoUnsaved(current.lines, rows, write) ?? current.lines,
    }));
    return true;
  };

  /**
   * Every unsaved change of the day, saved in ONE call:
   * save_arrangement_changes (migration 0103) writes every cell in one
   * transaction — a refusal anywhere saves nothing — and refuses, never
   * overwrites, a cell that no longer holds what its change was typed over
   * (`expected`), or whose order went meanwhile.
   *
   * A mutation, like every other write in the app, because that is what
   * lib/live-updates.ts looks at: it will not re-read this device's screens
   * while one is in flight. The callbacks sit on the hook, not on the mutate()
   * call, so they still run if the screen is left mid-save — and they only
   * reach for what outlives it: the query cache, and the store, by the day
   * the save was for.
   */
  const saveChangesMutation = useMutation({
    mutationKey: SAVE_CHANGES_KEY,
    mutationFn: async ({
      tradingDayId,
      allocations,
    }: {
      tradingDayId: string;
      allocations: ProposedAllocation[];
      /** The lines the allocations were landed from: what a save that lands lets go of. */
      sent: readonly ProposalLine[];
    }) => {
      const parsed = saveArrangementChangesInputSchema.parse({
        tradingDayId,
        changes: allocations.map((allocation) => ({
          dailyPickProductId: allocation.pickLineId,
          customerCompanyId: allocation.customerId,
          quantityPallets: allocation.quantity,
          // What the cell held when it was changed here, so the database can
          // refuse a cell somebody has changed since.
          expected: {
            recordId: allocation.expected.recordId,
            quantityPallets: allocation.expected.quantity,
          },
          // So the database can refuse a cell whose order went meanwhile.
          ...(allocation.forOrder ? { forOrder: true } : {}),
        })),
      });
      const { data, error } = await supabase.rpc(
        "save_arrangement_changes",
        toSaveArrangementChangesRpcArgs(parsed),
      );
      if (error) throw error;
      return data;
    },
    onSuccess: async (saved, { tradingDayId, sent }) => {
      // Re-read BEFORE the changes are let go, and wait for it — the mutation
      // stays pending meanwhile, so the grid stays held. Letting them go first
      // would show every cell just saved as it stood before, for the moment
      // between the two. The saved day's grid whether or not it is on screen
      // (refetchType "all"): a grid left mid-save is read again too, so
      // coming back to it shows the saved numbers, not its copy from before
      // the save. That day's only: the save changed no other, and re-reading
      // every day still cached would keep the grid held for downloads it
      // cannot need.
      void queryClient.invalidateQueries({ queryKey: arrangementKeys.boardDataAll });
      await queryClient.invalidateQueries({
        queryKey: newArrangementKeys.matrix(tradingDayId),
        refetchType: "all",
      });
      // The lines that were sent, not whatever the day holds by now: what
      // this save did not carry, it did not save. Lines that landed nowhere
      // (already saved, a suggestion left out) go with them.
      updateDay(tradingDayId, (current) => ({
        lines: current.lines.filter((line) => !sent.includes(line)),
        refusal: null,
      }));
      showToast(`הסידור נשמר: ${saved} תאים.`, "success");
    },
    onError: async (error: RpcError, { tradingDayId }) => {
      // Nothing was saved. Re-read anyway, and wait for it: a refusal usually
      // means this screen's copy of the day is behind, and what is said and
      // let go below is worked out from the day as it is now. That day's
      // grid, on screen or not, as on success: with the screen left mid-save,
      // nothing else would read it again before it is shown.
      void queryClient.invalidateQueries({ queryKey: arrangementKeys.boardDataAll });
      await queryClient.invalidateQueries({
        queryKey: newArrangementKeys.matrix(tradingDayId),
        refetchType: "all",
      });
      const fresh = queryClient.getQueryData<MatrixDay | null>(
        arrangementQueries.matrix(tradingDayId).queryKey,
      );
      const reason = saveRefusalMessage({
        error,
        picks: fresh?.daily_picks ?? [],
        names: new Map((companiesQuery.data ?? []).map((company) => [company.id, company.name])),
        reason: describeRpcError(error, "0103"),
      });
      updateDay(tradingDayId, (current) => {
        let lines = current.lines;
        if (fresh) {
          // A conflict mends itself: the cells it names changed since they
          // were changed here, so the numbers typed in them go, and those
          // cells show what is saved. Every other refusal keeps every number,
          // to be corrected and saved again.
          if (error.code === ARRANGEMENT_ERROR_CODES.CONFLICT) {
            lines = dropCells(lines, fresh.daily_picks, refusedCells(error.details));
          }
          // A change whose cell already holds its number has nothing left to
          // save — the answer to an earlier save that landed may have been
          // lost on the way — and sent again it would be refused as a
          // conflict with itself.
          lines = pruneSaved(lines, {
            picks: fresh.daily_picks,
            orders: fresh.daily_orders,
            records: fresh.daily_arrangements?.arrangement_records ?? [],
          });
        }
        // Kept on the bar: a toast is gone in four seconds, and the cells it
        // is about are still sitting in the grid to be corrected.
        return { lines, refusal: reason };
      });
      showToast(reason, "error");
    },
  });

  /**
   * "הצע סידור": works out a proposal for the day and adds it to the unsaved
   * changes, to be corrected in the grid and saved with "שמור שינויים".
   * Writes nothing.
   *
   * The day on screen as it stands — orders, what is free on each lot, what
   * is already arranged — plus the last HISTORY_DAYS days, read now; the rules
   * are arrangement-engine.ts's (see proposeForDay). Cells already arranged
   * are never proposed over.
   *
   * Only while nothing unsaved is on the grid (unsavedCount): the engine
   * plans against what is saved, and beside unsaved numbers it could plan the
   * same pallets twice. Lines that land nowhere — a suggestion whose cells
   * were filled meanwhile, one held to an order since withdrawn — show
   * nothing and save nothing, so they do not hold it back; the suggestion
   * replaces them. The grid is held on this screen while it is worked out
   * (gridEditable — `proposing` is this screen's own state), so nothing can
   * be typed on it in the meantime for the suggestion to replace.
   */
  const suggestArrangement = async () => {
    if (!boardDay || !arrangement || savingChanges || proposing) return;
    if (unsavedCount > 0) return;
    setProposing(true);
    try {
      const learnedFrom = await readEngineHistory(supabase, boardDay.trade_date);
      // The day as it stands NOW, from the same cache entry, not as it stood
      // when the button was pressed: the history read takes a moment, and
      // anything saved meanwhile (lib/live-updates.ts re-reads the day) must be
      // worked around, not proposed over.
      const today = queryClient.getQueryData<MatrixDay | null>(boardDataQueryKey);
      const todaysArrangement = today?.daily_arrangements;
      if (!today || todaysArrangement?.status !== "open") {
        showToast("הסידור נסגר בזמן שההצעה חושבה. לא הוצע דבר.", "error");
        return;
      }
      const records = todaysArrangement.arrangement_records;
      const lines = proposeForDay({
        tradeDate: today.trade_date,
        picks: today.daily_picks,
        orders: today.daily_orders,
        records,
        learnedFrom,
      });
      const offered = resolveProposal({
        lines,
        picks: today.daily_picks,
        orders: today.daily_orders,
        records,
      });
      if (offered.allocations.length === 0) {
        showToast("אין מה להציע: כל מה שהוזמן ויש לו מלאי כבר משובץ.");
        return;
      }
      // Into the store, under the day it was worked out for, in place of
      // whatever lines it held: none of them was on the grid when the
      // suggestion was asked for (the guard above). A leftover refusal
      // message goes too: the suggestion starts afresh.
      updateDay(today.id, () => ({ lines, refusal: null }));
    } catch (error) {
      showToast(`חישוב הצעת הסידור נכשל: ${errorMessage(error)}`, "error");
    } finally {
      setProposing(false);
    }
  };

  // Set the moment a save is asked for, before the next render can show the
  // mutation as running: two clicks inside one frame would otherwise both get
  // through, and the second be refused for cells the first had just changed.
  const saveRequested = useRef(false);

  /** "שמור שינויים": saves every unsaved change of the day on screen. */
  const saveChanges = () => {
    if (!boardDay || !proposal || savingChanges || saveRequested.current) return;
    if (proposal.allocations.length === 0) return;
    saveRequested.current = true;
    // The last refusal is about the last attempt; this one gets its own.
    updateDay(boardDay.id, (current) => ({ ...current, refusal: null }));
    saveChangesMutation.mutate(
      { tradingDayId: boardDay.id, allocations: proposal.allocations, sent: unsaved.lines },
      {
        onSettled: () => {
          saveRequested.current = false;
        },
      },
    );
  };

  // Two loading stages — which day, then that day's grid — held behind one
  // skeleton so a slow connection doesn't flash an empty state between them.
  if (dayView.isLoading || (!!day && boardDataQuery.isLoading)) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }

  // A failed load must not present itself as "no trading day is open" — that
  // invites the distributor to open a day that already exists. Only when
  // nothing was ever loaded: a failed background re-read keeps the grid, and
  // whatever is being typed into it, on screen.
  if (dayView.isLoadError || (boardDataQuery.isError && boardDataQuery.data === undefined)) {
    return (
      <QueryError
        what="לוח הסידור"
        onRetry={() => {
          void dayView.refetch();
          // Not with no day: refetch() ignores `enabled`, and a read for a null
          // id fails on its own, keeping this screen up even when the day
          // comes back as "none open". A day that arrives starts it anyway.
          if (day) void boardDataQuery.refetch();
        }}
        retrying={dayView.isFetching || boardDataQuery.isFetching}
      />
    );
  }

  if (!boardDay || !arrangement) {
    return (
      <div className="max-w-xl rounded-xl bg-surface shadow-raised ring-1 ring-inset ring-border/70">
        <EmptyState
          icon="clock"
          title={dayView.isLive ? "אין יום מסחר פתוח" : "לא נמצא יום מסחר בתאריך זה"}
          hint={
            dayView.isLive
              ? "פתח יום עסקים בסרגל הצד כדי לסדר את ליקוטי היום מול ההזמנות."
              : "בחר תאריך אחר בסרגל הצד, או חזור ליום הפעיל."
          }
        />
      </div>
    );
  }

  // Unsaved changes leave the grid open: they are there to be corrected
  // before they are saved, and which numbers are not in the database yet is
  // told by how the box is drawn, not by locking it (see commitCell for where
  // a typed number goes). A save that is still running does hold every cell,
  // whichever mount of this screen began it: a number typed into a cell while
  // its change is being saved would race the save. So does "הצע סידור" while
  // it works a suggestion out: the engine plans against what is saved only,
  // so a number typed meanwhile would be planned over — and then thrown away,
  // since the suggestion takes the day's lines (see suggestArrangement).
  const gridEditable = editable && !savingChanges && !proposing;
  // A refusal stays on the bar even once there is nothing left to save: a
  // conflict can let go of every change it was about.
  const showBar = editable && (unsavedCount > 0 || unsaved.refusal !== null);
  // What "הצע סידור" put among the changes, once its suggestions are held to
  // the orders (see resolveProposal).
  const suggestedCells = proposal?.suggestedCells ?? 0;
  const suggestedPallets = proposal?.suggestedPallets ?? 0;
  // Counted on every read of the day, not once when offered: lines drop out
  // as cells are filled and orders change while the suggestion is unsaved.
  // Two counts, because they have different causes: a cell the day has no
  // room for, against a line held to what the customer has on order. Lines
  // of the suggestion only: a number typed that lands nowhere was never one.
  const leftOut = proposal ? proposal.alreadyArranged + proposal.unplaceableSuggestions : 0;
  const heldToOrder = proposal?.heldToOrder ?? 0;
  // Why the grid is empty, when the cut-down view is why: its own message
  // assumes a search that matched nothing.
  const emptyLabel =
    onlyOrdered && shown.rows.length === 0
      ? 'עדיין לא הוזמן דבר ביום זה. לחץ על "הצג הכול" כדי לחזור לכל המוצרים.'
      : onlyOrdered
        ? "אין מוצר מוזמן שמתאים לחיפוש."
        : null;

  return (
    <div className="flex flex-col">
      <PageHeader
        title="סידור לפי מוצרים"
        subtitle={new Intl.DateTimeFormat("he-IL", { dateStyle: "long" }).format(
          new Date(boardDay.trade_date),
        )}
        actions={
          <>
            {!editable && (
              <StatusPill tone="warning">
                {dayView.isLive ? "הסידור נסגר — קריאה בלבד" : "צפייה בעבר — לא ניתן לערוך"}
              </StatusPill>
            )}
            {/* Only while nothing unsaved is on the grid — see
                suggestArrangement. Gated on `editable`, not gridEditable:
                that is false while the suggestion is being worked out, and
                the button stays then, disabled, saying so. */}
            {editable && !savingChanges && unsavedCount === 0 && (
              <Button onClick={() => void suggestArrangement()} disabled={proposing}>
                {proposing ? "מחשב הצעה…" : "הצע סידור"}
              </Button>
            )}
            <Link
              to="/backoffice/arrangement"
              className="inline-flex h-10 items-center justify-center rounded-md bg-surface px-5 text-sm font-semibold text-ink shadow-card ring-1 ring-inset ring-border-strong transition-colors duration-200 hover:bg-surface-muted hover:text-accent hover:ring-accent/40"
            >
              לסידור לפי מגדל
            </Link>
          </>
        }
      />

      {/* The unsaved changes. Says what they are before it says what to do
          with them: a number not saved yet looks like any other at a glance
          but for its dashed box, and nothing about it is in the database. */}
      {showBar && (
        <div
          role="status"
          className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md bg-accent-soft px-4 py-3 ring-1 ring-inset ring-accent/30"
        >
          <p className="text-sm text-ink">
            {unsavedCount > 0 && (
              <span className="font-semibold">
                {unsavedCount === 1 ? "שינוי אחד שלא נשמר." : `${unsavedCount} שינויים שלא נשמרו.`}
              </span>
            )}
            {suggestedCells > 0 &&
              ` הצעת סידור: ${formatPallets(suggestedPallets)} משטחים ב-${suggestedCells} תאים.`}
            {leftOut > 0 &&
              ` ${leftOut} שורות מההצעה לא נכללו: כבר משובצות, או שאין להן מקום ביום זה.`}
            {heldToOrder > 0 &&
              ` ${heldToOrder} שורות קוצצו או ירדו כדי לא לעבור את מה שהלקוח הזמין.`}
            {unsaved.refusal && (
              <span className="block font-semibold text-danger">{unsaved.refusal}</span>
            )}
          </p>
          <div className="ms-auto flex items-center gap-2">
            <Button onClick={saveChanges} disabled={savingChanges || unsavedCount === 0}>
              {savingChanges ? "שומר…" : "שמור שינויים"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setDiscarding(true)}
              disabled={savingChanges}
            >
              בטל שינויים
            </Button>
          </div>
        </div>
      )}

      {/* The toolbar carries the one control the grid itself has no room for.
          A day can run to several hundred products, so search is how a
          distributor reaches a row at all — scrolling to it is not realistic. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-3">
        <label className="relative flex-1 sm:max-w-xs">
          <span className="sr-only">חיפוש מוצר</span>
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-ink-subtle"
          >
            <Icon name="search" className="h-4 w-4" />
          </span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="חיפוש מוצר…"
            className="h-10 w-full rounded-md bg-surface ps-9 pe-3 text-sm text-ink shadow-card ring-1 ring-inset ring-border-strong outline-none transition-colors duration-150 placeholder:text-ink-subtle focus:ring-2 focus:ring-accent/40"
          />
        </label>

        {/* A toggle, said as the thing pressing it will do. `aria-pressed`
            carries the state for a screen reader; the filled style carries it
            for everyone else. */}
        <Button
          variant={onlyOrdered ? "primary" : "secondary"}
          size="sm"
          aria-pressed={onlyOrdered}
          onClick={() => setOnlyOrdered((current) => !current)}
        >
          {onlyOrdered ? "הצג הכול" : "הצג רק מוזמנים"}
        </Button>

        <p className="text-xs text-ink-muted">
          {visible.rows.length} מוצרים · {visible.columns.length} לקוחות
        </p>

        {/* The two tints are the only things on the grid carrying meaning by
            colour alone, so each gets said in words rather than left to be
            inferred (the rule itself is matrix-data.ts's cellTone). */}
        <p className="flex items-center gap-2 text-xs text-ink-muted">
          <span
            aria-hidden
            className="h-3 w-3 rounded-sm bg-marked ring-1 ring-inset ring-marked-edge"
          />
          הוזמן וטרם שובץ
        </p>
        <p className="flex items-center gap-2 text-xs text-ink-muted">
          <span
            aria-hidden
            className="h-3 w-3 rounded-sm bg-arranged ring-1 ring-inset ring-arranged-edge"
          />
          שובץ
        </p>

        {showBar && (
          <p className="flex items-center gap-2 text-xs text-ink-muted">
            <span
              aria-hidden
              className="h-3 w-3 rounded-sm border border-dashed border-accent bg-accent-soft"
            />
            מספר בתא כזה = עדיין לא נשמר
          </p>
        )}

        {/* The keyboard hint only describes the desktop grid's own arrow-key
            navigation — meaningless on the mobile card list below, which has
            no cell-to-cell navigation at all (see arrangement-matrix-mobile.tsx).
            It also says where saving happens: Enter and Tab only accept the
            number into its box. */}
        {gridEditable && wide && (
          <p className="text-xs text-ink-subtle">
            {
              'הקלד כמות ולחץ Enter או Tab. חיצים לניווט בין תאים. השינויים נשמרים רק בלחיצה על "שמור שינויים".'
            }
          </p>
        )}
      </div>

      {wide ? (
        <ArrangementMatrix
          matrix={visible}
          expanded={expanded}
          onToggle={(varietyId) =>
            setExpanded((current) => {
              const next = new Set(current);
              if (!next.delete(varietyId)) next.add(varietyId);
              return next;
            })
          }
          editable={gridEditable}
          onCommit={commitCell}
          {...(emptyLabel ? { emptyLabel } : {})}
        />
      ) : (
        <ArrangementMatrixMobile
          matrix={visible}
          expanded={expanded}
          onToggle={(varietyId) =>
            setExpanded((current) => {
              const next = new Set(current);
              if (!next.delete(varietyId)) next.add(varietyId);
              return next;
            })
          }
          editable={gridEditable}
          onCommit={commitCell}
          {...(emptyLabel ? { emptyLabel } : {})}
        />
      )}

      {/* Asked first: one slip onto "בטל שינויים" would otherwise throw away
          everything typed since the last save, with no way back. */}
      <Dialog
        open={discarding}
        onClose={() => setDiscarding(false)}
        title="לבטל את כל השינויים שלא נשמרו?"
      >
        <p className="mb-4 text-sm">השינויים שלא נשמרו יימחקו.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDiscarding(false)}>
            המשך לערוך
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              // The whole day emptied, not just its lines: a refusal left on
              // the bar goes with the changes it was about.
              updateDay(boardDay.id, () => EMPTY_UNSAVED_DAY);
              setDiscarding(false);
            }}
          >
            בטל שינויים
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

interface RpcError {
  code?: string;
  message?: string;
  /** PostgREST's copy of the error's DETAIL — where save_arrangement_changes names the cells. */
  details?: string | null;
}

// The arrangement functions raise named SQLSTATEs (packages/domain's
// ARRANGEMENT_ERROR_CODES). Same translation the board does — kept as its own
// copy here rather than shared because the two screens can reasonably word
// the same refusal differently: here it is read on the bar, after the cells
// it names (see saveRefusalMessage), once a save has written nothing.
function describeRpcError(error: RpcError, migration: string): string {
  switch (error.code) {
    case ARRANGEMENT_ERROR_CODES.OVER_ALLOCATION:
      return "הכמות חורגת ממה שנקטף בשורת הליקוט או ממה שהלקוח הזמין.";
    case ARRANGEMENT_ERROR_CODES.INVALID_STATE:
      return "הסידור כבר סגור.";
    case ARRANGEMENT_ERROR_CODES.NOT_FOUND:
      return "השורה או ההזמנה כבר לא קיימות. רענן את הדף.";
    case ARRANGEMENT_ERROR_CODES.CONFLICT:
      return "התא כבר שובץ בינתיים.";
    case ARRANGEMENT_ERROR_CODES.INVALID_INPUT:
      return "הכמות אינה תקינה.";
    // Postgres broke a lock cycle with another write landing at the same
    // moment (a grower's pick being saved, say) by giving up on this one.
    // Nothing was written; trying again is all it takes.
    case "40P01":
      return "השמירה התנגשה בשינוי אחר שנעשה באותו רגע. נסה שוב.";
    // PostgREST's "no function matches". Worth naming because migrations here
    // are applied by hand: the grid's one save calls save_arrangement_changes,
    // which does not exist until 0103 is run, and the raw message reads as a
    // bug rather than as a pending migration.
    case "PGRST202":
      return `פעולה זו דורשת מיגרציה שטרם הורצה (${migration}). הרץ pnpm db:migrate.`;
    default:
      return errorMessage(error);
  }
}
