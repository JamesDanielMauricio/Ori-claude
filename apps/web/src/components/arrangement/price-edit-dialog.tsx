import { saveProductInputSchema, toSaveProductRpcArgs } from "@ori/domain/reference-data";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { FormField, inputClassName } from "@/components/reference-data/form-field";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { QueryError } from "@/components/ui/query-error";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/error-message";
import { blockWheel } from "@/lib/integer-input";
import { toInputText } from "@/lib/number-field";
import { optimisticUpdate } from "@/lib/optimistic-mutation";
import {
  arrangementKeys,
  arrangementQueries,
  type ProductVarietyRow,
} from "@/lib/queries/arrangement";
import { customerKeys } from "@/lib/queries/customer";
import { referenceDataQueries } from "@/lib/queries/reference-data";
import { createClient } from "@/lib/supabase/client";
import { formatVarietyName } from "@/lib/variety-label";

// Per-variety price configuration, launched from the arrangement
// workspace. Reuses save_product (packages/domain/src/reference-data) —
// the same version-guarded, full-row RPC the Products screen uses —
// rather than a new price-only RPC: a price is just one field on the
// variety row, and save_product already carries the R7 conflict guard
// this write needs just as much as any other product edit.
export function PriceEditDialog({
  varietyId,
  onClose,
}: {
  varietyId: string | null;
  onClose: () => void;
}) {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [price, setPrice] = useState("");
  const [priceRangeFrom, setPriceRangeFrom] = useState("");
  const [priceRangeTo, setPriceRangeTo] = useState("");
  const [priceType, setPriceType] = useState("");

  const varietyQuery = useQuery(arrangementQueries.priceVariety(varietyId));

  // Seeded once per variety, not on every change of varietyQuery.data.
  //
  // Keyed on the data object, this re-ran on any refetch — and React Query
  // refetches on window focus once the query is stale (30s, lib/providers.tsx).
  // A distributor who opened this dialog, typed a new price, checked something
  // in another window and came back found their entry replaced by the old
  // stored value, with no indication anything had been discarded. Seeding from
  // the id means a refetch can no longer overwrite what someone is typing.
  //
  // The version is kept from the same snapshot, and it is the one a save
  // sends: the inputs show that row, so a newer one that a refetch brought
  // meanwhile must be refused as a conflict (R7), not silently overwritten.
  const [seeded, setSeeded] = useState<{ varietyId: string; version: number } | null>(null);
  useEffect(() => {
    // Closing clears the marker, so reopening the SAME variety seeds again
    // from the server rather than resurrecting the last thing typed into a
    // dialog that was dismissed. This component stays mounted between
    // openings — varietyId just goes back to null.
    if (varietyId === null) {
      setSeeded(null);
      return;
    }
    if (!varietyQuery.data || seeded?.varietyId === varietyId) return;
    setSeeded({ varietyId, version: varietyQuery.data.version });
    // The inputs hold text; the prices arrive as numbers.
    setPrice(toInputText(varietyQuery.data.price));
    setPriceRangeFrom(toInputText(varietyQuery.data.price_range_from));
    setPriceRangeTo(toInputText(varietyQuery.data.price_range_to));
    setPriceType(varietyQuery.data.price_type ?? "");
  }, [varietyQuery.data, varietyId, seeded]);

  type VarietyRow = ProductVarietyRow & { product_families: { name: string } | null };

  // Keyed by the variety a save was started for, never by the render: a
  // mutation's callbacks run with the options of whichever render is latest
  // when they fire, so a save still in flight after the dialog was closed and
  // reopened on another product would otherwise roll back, re-version and
  // re-read THAT product's cache instead of its own.
  const optimisticFor = (savedVarietyId: string) =>
    optimisticUpdate<VarietyRow, string>(
      queryClient,
      arrangementKeys.priceVariety(savedVarietyId),
      (row) =>
        row
          ? {
              ...row,
              price: price === "" ? null : Number(price),
              price_range_from: priceRangeFrom === "" ? null : Number(priceRangeFrom),
              price_range_to: priceRangeTo === "" ? null : Number(priceRangeTo),
              price_type: priceType || null,
            }
          : row,
    );

  const saveMutation = useMutation({
    // The variety the save is for: what every callback below keys off.
    mutationFn: async (savedVarietyId: string) => {
      const row = varietyQuery.data;
      // The save button is disabled until the product has loaded; this is
      // the backstop behind it.
      if (!row || row.id !== savedVarietyId || seeded?.varietyId !== row.id) {
        throw new Error("נתוני המוצר עדיין לא נטענו");
      }
      const input = saveProductInputSchema.parse({
        id: row.id,
        familyId: row.family_id,
        name: row.name,
        sizes: row.sizes,
        packType: row.pack_type,
        price: price === "" ? null : Number(price),
        priceRangeFrom: priceRangeFrom === "" ? null : Number(priceRangeFrom),
        priceRangeTo: priceRangeTo === "" ? null : Number(priceRangeTo),
        priceType: priceType || null,
        noOverbooking: Number(row.no_overbooking),
        highlightPriceFluctuations: row.highlight_price_fluctuations,
        isSeasonalAvailable: row.is_seasonal_available,
        // This dialog only edits price — passed through unchanged, same as
        // noOverbooking/isSeasonalAvailable above.
        numberOfOrdersPerCustomer: row.number_of_orders_per_customer,
        expectedVersion: seeded.version,
      });
      const { data, error } = await supabase.rpc("save_product", toSaveProductRpcArgs(input));
      if (error) throw error;
      return data;
    },
    onMutate: (savedVarietyId) => optimisticFor(savedVarietyId).onMutate(savedVarietyId),
    onSuccess: (saved, savedVarietyId) => {
      showToast("המחיר עודכן.", "success");
      const savedKey = arrangementKeys.priceVariety(savedVarietyId);
      // The version the server just agreed to, before the refetch lands: a
      // reopening meanwhile seeds from this row, and with the old version its
      // next save would be refused as a conflict with itself.
      queryClient.setQueryData<VarietyRow>(
        savedKey,
        (row) => row && { ...row, version: saved.version },
      );
      // The caches that show this variety's price. Not the boards: their
      // day tree carries record prices only, never the variety's.
      void queryClient.invalidateQueries({ queryKey: savedKey });
      void queryClient.invalidateQueries({ queryKey: referenceDataQueries.products().queryKey });
      void queryClient.invalidateQueries({ queryKey: customerKeys.catalogAll });
      // Only if it still shows this product — not one opened while saving.
      if (varietyId === savedVarietyId) onClose();
    },
    onError: (error: { message?: string }, savedVarietyId, context) => {
      optimisticFor(savedVarietyId).onError(error, savedVarietyId, context);
      showToast(`עדכון המחיר נכשל: ${errorMessage(error)}`, "error");
      // Re-read on failure too: after a conflict the rollback above restores
      // the row that lost, and the next opening must seed from the one that won.
      void queryClient.invalidateQueries({
        queryKey: arrangementKeys.priceVariety(savedVarietyId),
      });
    },
  });

  const title = varietyQuery.data
    ? varietyQuery.data.product_families?.name
      ? `מחיר — ${varietyQuery.data.product_families.name} — ${formatVarietyName(varietyQuery.data.name, varietyQuery.data.sizes)}`
      : `מחיר — ${formatVarietyName(varietyQuery.data.name, varietyQuery.data.sizes)}`
    : "מחיר";

  return (
    <Dialog open={!!varietyId} onClose={onClose} title={title}>
      {varietyQuery.isLoading ? (
        <p className="text-sm text-ink-muted">טוען…</p>
      ) : varietyQuery.isError && varietyQuery.data === undefined ? (
        <QueryError
          what="נתוני המוצר"
          onRetry={() => void varietyQuery.refetch()}
          retrying={varietyQuery.isFetching}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <FormField label="מחיר" htmlFor="arr-price">
              <input
                id="arr-price"
                type="number"
                step="0.01"
                className={inputClassName}
                value={price}
                onWheel={blockWheel}
                onChange={(event) => setPrice(event.target.value)}
              />
            </FormField>
            <FormField label="טווח מ-" htmlFor="arr-price-from">
              <input
                id="arr-price-from"
                type="number"
                step="0.01"
                className={inputClassName}
                value={priceRangeFrom}
                onWheel={blockWheel}
                onChange={(event) => setPriceRangeFrom(event.target.value)}
              />
            </FormField>
            <FormField label="טווח עד" htmlFor="arr-price-to">
              <input
                id="arr-price-to"
                type="number"
                step="0.01"
                className={inputClassName}
                value={priceRangeTo}
                onWheel={blockWheel}
                onChange={(event) => setPriceRangeTo(event.target.value)}
              />
            </FormField>
          </div>
          <FormField label="סוג תמחור" htmlFor="arr-price-type">
            <input
              id="arr-price-type"
              className={inputClassName}
              value={priceType}
              onChange={(event) => setPriceType(event.target.value)}
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              ביטול
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (varietyId) saveMutation.mutate(varietyId);
              }}
              disabled={saveMutation.isPending || !varietyQuery.data}
            >
              {saveMutation.isPending ? "שומר…" : "שמור"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
