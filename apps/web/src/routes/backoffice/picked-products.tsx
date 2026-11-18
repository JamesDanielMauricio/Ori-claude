import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { StockEditDialog } from "@/components/arrangement/stock-edit-dialog";
import { ProductCatalogScreen } from "@/components/reference-data/product-catalog-screen";
import { StatusPill } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { QueryError } from "@/components/ui/query-error";
import { invalidateStockReads } from "@/lib/queries/arrangement";
import { NO_PICKED_STOCK, pickedProductsQueries } from "@/lib/queries/picked-products";
import { useTradingDayView } from "@/lib/trading-day-view";

const TITLE = "מוצרים שנקטפו";
const SUBTITLE =
  "אותו קטלוג, מצומצם למוצרים שיש מהם מלאי ביום המסחר שנבחר בסרגל הצד. העריכה נשמרת על המוצר עצמו — היא אינה מוגבלת ליום.";

// "מוצרים שנקטפו" — the Products screen narrowed to the day's real supply.
//
// The day comes from the sidebar's picker, the same way Shop, Arrangement and
// the two on-behalf-of screens resolve theirs (lib/trading-day-view.tsx), so
// pinning a past date narrows this list to what was picked THAT day.
//
// "Picked" here means the same thing the arrangement screens mean by available
// supply: a pick line with `pallets_picked > 0` OR `leftover_pallets > 0`.
// Merely HAVING a pick line is not enough and would make this tab pointless —
// `bootstrap_grower_pick` creates a line for every in-season product of every
// active grower when the day opens (migration 0014), so an unfiltered list is
// "what is in season", which is nearly the whole catalog. Leftover counts
// because it is arrangeable stock: `pallets_picked + leftover_pallets` is what
// `check_arrangement_allocation` allows to be given away (migration 0050).
export default function PickedProductsPage() {
  const dayView = useTradingDayView();
  const day = dayView.day;
  const queryClient = useQueryClient();
  // The pick line whose stock popup is open (null = closed).
  const [stockLineId, setStockLineId] = useState<string | null>(null);

  // Which varieties had supply on the day (see
  // pickedProductsQueries.varietiesForDay).
  const pickedQuery = useQuery(pickedProductsQueries.varietiesForDay(day?.id ?? null));

  // A failure is reported as a failure, never as "nothing was picked today":
  // that sentence is operationally significant here — it is the one a
  // distributor would act on by assuming the growers have not submitted yet.
  if (dayView.isLoadError || (pickedQuery.isError && pickedQuery.data === undefined)) {
    return (
      <>
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        {dayView.isLoadError ? (
          <QueryError
            what="יום המסחר"
            onRetry={() => void dayView.refetch()}
            retrying={dayView.isFetching}
          />
        ) : (
          <QueryError
            what="רשימות הליקוט של היום"
            onRetry={() => void pickedQuery.refetch()}
            retrying={pickedQuery.isFetching}
          />
        )}
      </>
    );
  }

  const tradeDateLabel = day
    ? new Intl.DateTimeFormat("he-IL", { dateStyle: "long" }).format(new Date(day.trade_date))
    : null;

  return (
    <>
      <ProductCatalogScreen
        title={TITLE}
        subtitle={SUBTITLE}
        // Which day these rows came from. Unlike the other date-aware screens
        // this one does NOT add "לא ניתן לערוך" when a past day is pinned: the
        // DAY decides which products are listed, but the records themselves are
        // catalog records with no day of their own, so editing one from here is
        // the same edit as from /backoffice/products and stays allowed.
        headerActions={
          <>
            {tradeDateLabel && <StatusPill tone="neutral">{tradeDateLabel}</StatusPill>}
            {!dayView.isLive && <StatusPill tone="warning">יום מסחר קודם</StatusPill>}
          </>
        }
        varietyIds={(pickedQuery.data ?? NO_PICKED_STOCK).varietyIds}
        // משטחים במלאי: each variety's picked + leftover pallets that day.
        stockByVariety={(pickedQuery.data ?? NO_PICKED_STOCK).stockByVariety}
        // The number becomes a stock-edit button for a product one grower
        // supplies — on the live day only; a pinned past day stays read-only.
        singleLineByVariety={(pickedQuery.data ?? NO_PICKED_STOCK).singleLineByVariety}
        {...(dayView.isLive ? { onEditStock: setStockLineId } : {})}
        extraLoading={dayView.isLoading || pickedQuery.isLoading}
        emptyLabel={
          day
            ? "לא נקטפו מוצרים ביום המסחר הזה."
            : dayView.isLive
              ? "אין יום מסחר פתוח."
              : "לא נמצא יום מסחר בתאריך שנבחר."
        }
      />

      {/* The quick stock edit, the same popup as the arrangement grid. */}
      <StockEditDialog
        pickLineId={stockLineId}
        onClose={() => setStockLineId(null)}
        onSaved={() => {
          if (day) invalidateStockReads(queryClient, day.id);
          setStockLineId(null);
        }}
      />
    </>
  );
}
