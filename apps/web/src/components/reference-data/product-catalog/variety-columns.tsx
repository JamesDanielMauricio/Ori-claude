import type { UseQueryResult } from "@tanstack/react-query";
import type { Dispatch, SetStateAction } from "react";

import { checkboxClassName, inputClassName } from "@/components/reference-data/form-field";
import type { RecordTableColumn } from "@/components/reference-data/record-table";
import { StatusPill } from "@/components/ui/card";
import { ProductThumbnail } from "@/components/ui/product-thumbnail";
import { Select } from "@/components/ui/select";
import { blockWheel } from "@/lib/integer-input";
import { formatPallets } from "@/components/arrangement/board-data";
import type { ProductFamily, ProductVariety } from "@/lib/queries/reference-data";

import {
  CREATED_AT_FORMAT,
  NAME_GUTTER,
  NEW_ROW_ID,
  PACK_TYPE_LABEL,
  orDash,
  type FormState,
} from "./catalog-form";
import { ProductCodeCell } from "./product-code-cell";
import type { useVarietyPhoto } from "./use-variety-photo";
import { VarietyPhotoButton } from "./variety-photo-button";

export interface VarietyColumnsContext {
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  familyById: ReadonlyMap<string, ProductFamily>;
  familiesQuery: UseQueryResult<ProductFamily[]>;
  openFamily: (familyId: string) => void;
  // The variety picture being edited (migration 0094) — see useVarietyPhoto.
  photo: ReturnType<typeof useVarietyPhoto>;
  // While a save is in flight the picture control is disabled.
  saving: boolean;
  // מוצרים שנקטפו only — see ProductCatalogScreen's prop of the same name.
  stockByVariety?: ReadonlyMap<string, number> | undefined;
}

// The two family-level fields the flat table used to repeat on every
// variety row — the photo and the category — are gone from the columns
// below. They now appear once, on their family's own header row, where
// they are also editable; keeping a read-only copy per variety would show
// the same value in two places and let only one of them be changed.
export function buildVarietyColumns({
  form,
  setForm,
  familyById,
  familiesQuery,
  openFamily,
  photo,
  saving,
  stockByVariety,
}: VarietyColumnsContext): RecordTableColumn<ProductVariety>[] {
  return [
    {
      key: "name",
      label: "זן",
      groupLabel: "משפחה",
      // Every family's expand toggle and "זן חדש" button live in this
      // column, so hiding it would strand the whole catalog closed.
      alwaysVisible: true,
      // The variety's own picture (migration 0094) sits in the gutter the
      // family row uses for its photo, so every name in the column still
      // starts on one edge; a variety without a picture leaves it empty.
      render: (row) => (
        <span className="flex items-center font-medium text-ink">
          <span className={`flex ${NAME_GUTTER} shrink-0 items-center`}>
            {row.image_url && <ProductThumbnail imageUrl={row.image_url} size="sm" />}
          </span>
          {row.name}
        </span>
      ),
      renderEdit: () => (
        // The same gutter as the read state, so the field opens exactly
        // where the name it replaces was sitting — with the picture control
        // where the picture was.
        <div className="flex items-center">
          <span className={`flex ${NAME_GUTTER} shrink-0 items-center`}>
            <VarietyPhotoButton
              pendingPhotoFile={photo.pendingPhotoFile}
              imageUrl={form.imageUrl}
              previewUrl={photo.photoPreviewUrl}
              inputRef={photo.photoInputRef}
              disabled={saving}
              onRemove={photo.handleRemovePhoto}
            />
            {/* Opened by clicking the picture; uploaded only on שמור. */}
            <input
              ref={photo.photoInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={photo.handlePhotoFileChange}
            />
          </span>
          <input
            aria-label="זן / שם"
            autoFocus
            required
            className={`${inputClassName} w-full min-w-[9rem]`}
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          />
        </div>
      ),
    },
    // משטחים במלאי (Bubble's ריכוז מוצרים): right after the name, as Bubble
    // has it after שם. Read-only, and only where a day is in view. The family
    // row leaves it empty — Bubble showed the category there, which Ori
    // already shows in its own column.
    ...(stockByVariety
      ? [
          {
            key: "stock",
            label: "משטחים במלאי",
            render: (row: ProductVariety) => formatPallets(stockByVariety.get(row.id) ?? 0),
          },
        ]
      : []),
    {
      key: "family",
      label: "משפחה",
      groupLabel: "קטגוריה",
      // Redundant with the header row this variety already sits under while
      // it's only being read — but it stays, because MOVING a variety to a
      // different family is a real edit and this dropdown is the only place
      // it can be made. Changing it moves the row under the family it names
      // straight away (see `getGroupId` below — an editing row is grouped by
      // the family it is about to be SAVED to, not the one it came from),
      // which is why the target family is opened here too: otherwise the row
      // would drop into a collapsed group and vanish mid-edit.
      // Drawn in the muted ink rather than the body ink: in a grouped table
      // every row of a section repeats that section's own name, which makes
      // this the most-repeated text on the screen and, at full strength, the
      // thing the eye keeps landing on instead of the fields that actually
      // differ from row to row. It stays visible — a row can be searched into
      // view away from its family, and an orphan row has no header above it
      // at all — just quieter.
      render: (row) => (
        <span className="text-ink-muted">{orDash(familyById.get(row.family_id)?.name)}</span>
      ),
      renderEdit: () => (
        <Select
          aria-label="משפחה"
          className="w-full min-w-[8rem]"
          value={form.familyId}
          onChange={(next) => {
            openFamily(next);
            setForm((current) => ({ ...current, familyId: next }));
          }}
          options={
            familiesQuery.data?.map((family) => ({ value: family.id, label: family.name })) ?? []
          }
        />
      ),
    },
    {
      key: "sizes",
      label: "גודל",
      groupLabel: "מספר זנים",
      render: (row) => orDash(row.sizes),
      renderEdit: () => (
        <input
          aria-label="גדלים"
          className={`${inputClassName} w-28`}
          value={form.sizes}
          onChange={(event) => setForm((current) => ({ ...current, sizes: event.target.value }))}
        />
      ),
    },
    {
      key: "packType",
      label: "סוג אריזה",
      render: (row) => orDash(row.pack_type ? PACK_TYPE_LABEL[row.pack_type] : null),
      renderEdit: () => (
        <Select
          aria-label="סוג אריזה"
          className="w-28"
          value={form.packType}
          onChange={(next) => setForm((current) => ({ ...current, packType: next }))}
          options={[
            { value: "", label: "—" },
            { value: "pallets", label: "משטחים" },
            { value: "crates", label: "ארגזים" },
          ]}
        />
      ),
    },
    {
      key: "price",
      label: "מחיר",
      render: (row) => orDash(row.price),
      renderEdit: () => (
        <input
          type="number"
          step="0.01"
          aria-label="מחיר"
          className={`${inputClassName} w-24`}
          value={form.price}
          onWheel={blockWheel}
          onChange={(event) => setForm((current) => ({ ...current, price: event.target.value }))}
        />
      ),
    },
    {
      key: "priceFrom",
      label: "טווח מ-",
      render: (row) => orDash(row.price_range_from),
      renderEdit: () => (
        <input
          type="number"
          step="0.01"
          aria-label="טווח מ-"
          className={`${inputClassName} w-24`}
          value={form.priceRangeFrom}
          onWheel={blockWheel}
          onChange={(event) =>
            setForm((current) => ({ ...current, priceRangeFrom: event.target.value }))
          }
        />
      ),
    },
    {
      key: "priceTo",
      label: "טווח עד",
      render: (row) => orDash(row.price_range_to),
      renderEdit: () => (
        <input
          type="number"
          step="0.01"
          aria-label="טווח עד"
          className={`${inputClassName} w-24`}
          value={form.priceRangeTo}
          onWheel={blockWheel}
          onChange={(event) =>
            setForm((current) => ({ ...current, priceRangeTo: event.target.value }))
          }
        />
      ),
    },
    {
      key: "priceType",
      label: "סוג מחיר",
      render: (row) => orDash(row.price_type),
      renderEdit: () => (
        <input
          aria-label="סוג תמחור"
          className={`${inputClassName} w-28`}
          value={form.priceType}
          onChange={(event) =>
            setForm((current) => ({ ...current, priceType: event.target.value }))
          }
        />
      ),
    },
    {
      key: "overbooking",
      label: "הזמנת יתר",
      render: (row) => row.no_overbooking,
      renderEdit: () => (
        <input
          type="number"
          step="1"
          min={0}
          aria-label="חריגת הזמנה מותרת (No Overbooking)"
          className={`${inputClassName} w-24`}
          value={form.noOverbooking}
          onWheel={blockWheel}
          onChange={(event) =>
            setForm((current) => ({ ...current, noOverbooking: event.target.value }))
          }
        />
      ),
    },
    {
      key: "orderCap",
      label: "מקס' הזמנות ללקוח",
      // The customer order screen's dropdown (order-product-list.tsx) reads
      // this as its own ceiling — never applied to a backoffice
      // on-behalf-of edit, where staff may deliberately exceed it. Empty
      // means uncapped.
      render: (row) => orDash(row.number_of_orders_per_customer),
      renderEdit: () => (
        <input
          type="number"
          step="1"
          // 1, not 0: saveProductInputSchema requires a positive cap, and
          // "no cap" is the empty box, not zero.
          min={1}
          placeholder="ללא הגבלה"
          aria-label="כמות מקסימלית להזמנה ללקוח (Number of Orders per Customer)"
          className={`${inputClassName} w-28`}
          value={form.numberOfOrdersPerCustomer}
          onWheel={blockWheel}
          onChange={(event) =>
            setForm((current) => ({ ...current, numberOfOrdersPerCustomer: event.target.value }))
          }
        />
      ),
    },
    // No "תקרות ללקוח" (per-customer caps) column: nothing ever enforced
    // them, and the one per-customer limit is number_of_orders_per_customer
    // above (James, 2026-11-05). The caps themselves were removed on
    // 2026-11-09 (migrations 0087, 0091).
    {
      key: "seasonal",
      label: "בעונה",
      render: (row) => (
        <StatusPill tone={row.is_seasonal_available ? "accent" : "neutral"} dot>
          {row.is_seasonal_available ? "בעונה" : "לא בעונה"}
        </StatusPill>
      ),
      renderEdit: () => (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className={checkboxClassName}
            aria-label="זמין בעונה הנוכחית"
            checked={form.isSeasonalAvailable}
            onChange={(event) =>
              setForm((current) => ({ ...current, isSeasonalAvailable: event.target.checked }))
            }
          />
          {form.isSeasonalAvailable ? "בעונה" : "לא בעונה"}
        </label>
      ),
    },
    {
      key: "highlight",
      label: "הבלטת תנודות מחיר",
      render: (row) => (row.highlight_price_fluctuations ? "כן" : "לא"),
      renderEdit: () => (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className={checkboxClassName}
            aria-label="הדגש תנודות מחיר"
            checked={form.highlightPriceFluctuations}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                highlightPriceFluctuations: event.target.checked,
              }))
            }
          />
          {form.highlightPriceFluctuations ? "כן" : "לא"}
        </label>
      ),
    },
    {
      key: "created",
      label: "נוצר",
      render: (row) =>
        orDash(row.created_at ? CREATED_AT_FORMAT.format(new Date(row.created_at)) : null),
    },
    // קוד מוצר: the variety's id, which is its product code — what a file's
    // "קוד מוצר" column names a product by in the "בשם מגדל" picking upload
    // (lib/picking-import.ts). Not a field of its own, by the product owner's
    // decision: the id is unique already and never changes. Last, as it is
    // a reference to copy rather than a value to read across the row, and
    // read-only — no renderEdit, and nothing of it in the form or the save.
    // A draft not yet saved has no id yet, so it shows nothing.
    {
      key: "code",
      label: "קוד מוצר",
      render: (row) => (row.id === NEW_ROW_ID ? null : <ProductCodeCell code={row.id} />),
    },
  ];
}
