import {
  PRODUCT_VERSION_CONFLICT_ERROR_CODE,
  saveProductInputSchema,
  toSaveProductRpcArgs,
} from "@ori/domain/reference-data";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

import type { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/error-message";
import { mergeOnError, optimisticUpdate } from "@/lib/optimistic-mutation";
import { customerKeys } from "@/lib/queries/customer";
import { referenceDataQueries, type ProductVariety } from "@/lib/queries/reference-data";
import { createClient } from "@/lib/supabase/client";

import { productPhotoPathFromUrl, toFormState, type FormState } from "./catalog-form";
import { removeVarietyPhotoFile, replacedPhotoPath, uploadVarietyPhoto } from "./variety-photo";

// Saving and deleting a variety, each patching the table at once and
// rolling back if the server refuses (see lib/optimistic-mutation.ts).
// Re-created every render with that render's form, like any hook here.
export function useVarietyMutations({
  queryClient,
  showToast,
  form,
  setForm,
  editingRowId,
  setEditingId,
  deleteTarget,
  setDeleteTarget,
  pendingPhotoFile,
  setPendingPhotoFile,
}: {
  queryClient: QueryClient;
  showToast: ReturnType<typeof useToast>["showToast"];
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  editingRowId: string | null;
  setEditingId: Dispatch<SetStateAction<string | null>>;
  // The row itself, held from the click: the optimistic delete takes it out
  // of the cache before the picture cleanup below reads its URL.
  deleteTarget: ProductVariety | null;
  setDeleteTarget: Dispatch<SetStateAction<ProductVariety | null>>;
  // A picture picked for the row being edited, not yet uploaded (migration
  // 0094 — see useVarietyPhoto). Uploaded on save, cleared once saved.
  pendingPhotoFile: File | null;
  setPendingPhotoFile: (file: File | null) => void;
}) {
  const supabase = createClient();
  const productsQueryKey = referenceDataQueries.products().queryKey;
  // The same varieties' names, as the Growers and Users chips and pickers
  // read them. Not mounted here, so invalidating it only marks it stale.
  const catalogQueryKey = referenceDataQueries.productCatalog().queryKey;

  // The picture as the table holds it NOW, at render — before a save's
  // optimistic patch rewrites the cached row — so the file a save replaces
  // can be removed. (A delete reads its row's picture from deleteTarget.)
  const cachedRows = queryClient.getQueryData<ProductVariety[]>(productsQueryKey);
  const previousImageUrl = cachedRows?.find((row) => row.id === editingRowId)?.image_url ?? null;

  // Patches every field the form edits except `version` — that's a real
  // optimistic-concurrency column, bumped by the server only. Leaving it
  // alone here means a stale version still gets caught by the real
  // PRODUCT_VERSION_CONFLICT_ERROR_CODE check below; faking a bump here
  // would just teach the UI to trust a number the server hasn't agreed to.
  const saveOptimistic = optimisticUpdate<ProductVariety[], void>(
    queryClient,
    productsQueryKey,
    (rows) =>
      rows?.map((row) =>
        row.id === editingRowId
          ? {
              ...row,
              family_id: form.familyId,
              name: form.name,
              sizes: form.sizes || null,
              pack_type: form.packType || null,
              // The same numbers the save itself sends (saveMutation below).
              price: form.price === "" ? null : Number(form.price),
              price_range_from: form.priceRangeFrom === "" ? null : Number(form.priceRangeFrom),
              price_range_to: form.priceRangeTo === "" ? null : Number(form.priceRangeTo),
              price_type: form.priceType || null,
              no_overbooking: Number(form.noOverbooking || "0"),
              highlight_price_fluctuations: form.highlightPriceFluctuations,
              is_seasonal_available: form.isSeasonalAvailable,
              number_of_orders_per_customer:
                form.numberOfOrdersPerCustomer === ""
                  ? null
                  : Number(form.numberOfOrdersPerCustomer),
              // A removed picture disappears at once; a newly picked one shows
              // when the save returns its uploaded link (onSuccess below).
              image_url: pendingPhotoFile ? row.image_url : form.imageUrl.trim() || null,
            }
          : row,
      ),
  );

  const saveMutation = useMutation({
    mutationFn: async (): Promise<ProductVariety> => {
      // A newly picked picture is uploaded first, the same way a family's is;
      // the save then points the row at it.
      const imageUrl = pendingPhotoFile
        ? await uploadVarietyPhoto(supabase, pendingPhotoFile)
        : form.imageUrl.trim();
      const input = saveProductInputSchema.parse({
        id: editingRowId,
        familyId: form.familyId,
        name: form.name,
        sizes: form.sizes || null,
        packType: form.packType || null,
        price: form.price === "" ? null : Number(form.price),
        priceRangeFrom: form.priceRangeFrom === "" ? null : Number(form.priceRangeFrom),
        priceRangeTo: form.priceRangeTo === "" ? null : Number(form.priceRangeTo),
        priceType: form.priceType || null,
        noOverbooking: Number(form.noOverbooking || "0"),
        highlightPriceFluctuations: form.highlightPriceFluctuations,
        isSeasonalAvailable: form.isSeasonalAvailable,
        numberOfOrdersPerCustomer:
          form.numberOfOrdersPerCustomer === "" ? null : Number(form.numberOfOrdersPerCustomer),
        expectedVersion: form.version,
        // Always sent: "" removes the picture (migration 0094).
        imageUrl,
      });
      const { data, error } = await supabase.rpc("save_product", toSaveProductRpcArgs(input));
      if (error) {
        // The picture just uploaded is referenced by nothing now.
        if (pendingPhotoFile) removeVarietyPhotoFile(supabase, productPhotoPathFromUrl(imageUrl));
        throw error;
      }
      removeVarietyPhotoFile(supabase, replacedPhotoPath(previousImageUrl, data.image_url));
      return data;
    },
    onMutate: async (variables) => {
      const rows = await saveOptimistic.onMutate(variables);
      return { rows };
    },
    onSuccess: (saved) => {
      // The version the server just agreed to (see saveOptimistic's note),
      // straight away rather than when the refetch lands: a variety re-opened
      // before then would be seeded with the old one, and its next save
      // refused as a conflict with itself. A create matches no cached row.
      queryClient.setQueryData<ProductVariety[]>(productsQueryKey, (rows) =>
        rows?.map((row) =>
          row.id === saved.id ? { ...row, version: saved.version, image_url: saved.image_url } : row,
        ),
      );
      showToast("הנתונים נשמרו.", "success");
      setPendingPhotoFile(null);
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: productsQueryKey });
      void queryClient.invalidateQueries({ queryKey: catalogQueryKey });
      // The order catalogs show its price (see customerKeys.catalogAll).
      void queryClient.invalidateQueries({ queryKey: customerKeys.catalogAll });
    },
    onError: async (
      error: { message?: string; code?: string },
      variables,
      context:
        | {
            rows: { previous: ProductVariety[] | undefined } | undefined;
          }
        | undefined,
    ) => {
      saveOptimistic.onError(error, variables, context?.rows);

      if (error.code !== PRODUCT_VERSION_CONFLICT_ERROR_CODE) {
        showToast(`השמירה נכשלה: ${errorMessage(error)}`, "error");
        return;
      }

      // Someone else saved this product first (R7). Refetch and re-seed the
      // row that's still open for editing from the values that actually
      // won, so the next save carries THEIR version rather than retrying
      // against a version the server has already moved past.
      showToast("המוצר עודכן על ידי משתמש אחר בינתיים. הנתונים רועננו — בדוק ושמור שוב.", "error");
      await queryClient.invalidateQueries({ queryKey: productsQueryKey });
      if (!editingRowId) return;
      const fresh = queryClient
        .getQueryData<ProductVariety[]>(productsQueryKey)
        ?.find((row) => row.id === editingRowId);
      if (!fresh) {
        setEditingId(null);
        return;
      }
      setForm(toFormState(fresh));
    },
  });

  const deleteOptimistic = optimisticUpdate<ProductVariety[], void>(
    queryClient,
    productsQueryKey,
    (rows) => rows?.filter((row) => row.id !== deleteTarget?.id),
  );

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!deleteTarget) return;
      const imageUrl = deleteTarget.image_url;
      const { error } = await supabase.from("product_varieties").delete().eq("id", deleteTarget.id);
      if (error) throw error;
      // Its own picture goes with it — best-effort, and only a file in Ori's
      // storage. Read from the row held since the click: by now the
      // optimistic delete has taken it out of the cache.
      removeVarietyPhotoFile(supabase, imageUrl ? productPhotoPathFromUrl(imageUrl) : null);
    },
    onMutate: deleteOptimistic.onMutate,
    onSuccess: () => {
      showToast("המוצר נמחק.", "success");
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: productsQueryKey });
      void queryClient.invalidateQueries({ queryKey: catalogQueryKey });
    },
    onError: mergeOnError(deleteOptimistic.onError, (error: { message?: string }) => {
      showToast(`המחיקה נכשלה: ${errorMessage(error)}`, "error");
      setDeleteTarget(null);
    }),
  });

  return { saveMutation, deleteMutation };
}
