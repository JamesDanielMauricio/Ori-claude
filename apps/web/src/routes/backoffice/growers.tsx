import { saveGrowerInputSchema, toSaveGrowerRpcArgs } from "@ori/domain/reference-data";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { formatPallets } from "@/components/arrangement/board-data";
import { CellChipList } from "@/components/reference-data/cell-popover";
import { buildCompanyDetailColumns } from "@/components/reference-data/company-detail-columns";
import {
  BLANK_COMPANY_DETAILS,
  toCompanyDetailsForm,
  toCompanyDetailsRow,
  type CompanyDetailsForm,
} from "@/components/reference-data/company-details";
import { ContactPersonEditCell, ContactPersonSummary } from "@/components/reference-data/contact-person-cell";
import { checkboxClassName, inputClassName } from "@/components/reference-data/form-field";
import { ProductMultiSelectCell } from "@/components/reference-data/product-multi-select-cell";
import { RecordTable, type RecordTableColumn } from "@/components/reference-data/record-table";
import {
  useWhatsAppGroupNames,
  WhatsAppGroupEditCell,
  WhatsAppGroupSummary,
  whatsAppGroupSearchText,
} from "@/components/reference-data/whatsapp-group-cell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { activeNameTaken } from "@/lib/company-name";
import { errorMessage } from "@/lib/error-message";
import { hasChanges } from "@/lib/has-changes";
import { mergeOnError, optimisticUpdate } from "@/lib/optimistic-mutation";
import { growerOversightKeys } from "@/lib/queries/oversight";
import {
  invalidateCompanyPickers,
  referenceDataQueries,
  type GrowerCompany,
} from "@/lib/queries/reference-data";
import { linesHoldingStock, readSeasonStock, type SeasonStockLine } from "@/lib/season-stock";
import { createClient } from "@/lib/supabase/client";
import { useCatalogOptions } from "@/lib/use-catalog-options";
import { useContactPersonDirectory } from "@/lib/use-contact-person-directory";

interface FormState {
  name: string;
  status: "active" | "inactive";
  defaultPickupTime: string;
  whatsappGroupId: string;
  productVarietyIds: Set<string>;
  transporterCompanyId: string;
  contactPersonId: string;
  noArrangementMessage: boolean;
  details: CompanyDetailsForm;
}

// Sentinel row id for a not-yet-created record: the draft row prepended to
// the table while `onAdd` is active, so RecordTable's "is this row being
// edited" logic (which compares ids) needs no separate create/update
// concept of its own.
const NEW_ROW_ID = "__new__";

const CREATED_AT_FORMAT = new Intl.DateTimeFormat("he-IL", { dateStyle: "short" });

const BLANK_FORM: FormState = {
  name: "",
  status: "active",
  defaultPickupTime: "",
  whatsappGroupId: "",
  productVarietyIds: new Set(),
  transporterCompanyId: "",
  contactPersonId: "",
  noArrangementMessage: false,
  details: BLANK_COMPANY_DETAILS,
};

function blankRow(): GrowerCompany {
  return {
    id: NEW_ROW_ID,
    name: "",
    status: "active",
    default_pickup_time: null,
    whatsapp_group_id: null,
    transporter_company_id: null,
    contact_person_id: null,
    phone: null,
    address_line: null,
    city: null,
    tax_id: null,
    accounting_id: null,
    no_arrangement_message: false,
    created_at: "",
  };
}

function toFormState(row: GrowerCompany, productVarietyIds: string[]): FormState {
  return {
    name: row.name,
    status: row.status,
    defaultPickupTime: row.default_pickup_time ?? "",
    whatsappGroupId: row.whatsapp_group_id ?? "",
    productVarietyIds: new Set(productVarietyIds),
    transporterCompanyId: row.transporter_company_id ?? "",
    contactPersonId: row.contact_person_id ?? "",
    noArrangementMessage: row.no_arrangement_message ?? false,
    details: toCompanyDetailsForm(row),
  };
}

// The Growers management screen (PRD: "Grower companies + their
// products-in-season list"). Every save goes through `save_grower` — one
// RPC call replaces the company row and its whole grower_products
// selection transactionally (R4); a plain `.update()` here would be a
// two-step client-side sequence with the exact partial-failure exposure
// the source app has.
export default function GrowersPage() {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  // Which row (by id) is being edited inline right now — NEW_ROW_ID for a
  // draft that hasn't been saved yet, an existing row's own id, or null.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  // Separate from `editingId` — deleting a row is still a confirm dialog,
  // not inline, so it needs its own target rather than reusing edit state.
  // The row itself, not its id: the optimistic delete takes it out of the
  // cache while the dialog is still naming it.
  const [deleteTarget, setDeleteTarget] = useState<GrowerCompany | null>(null);
  const deleteTargetId = deleteTarget?.id ?? null;
  // Workbook Task 04: the lines on today's pick that still hold stock for
  // varieties this save takes out of season — shown before the save, which
  // waits for "שמור בכל זאת". Null while there is nothing to warn about.
  const [stockWarning, setStockWarning] = useState<SeasonStockLine[] | null>(null);

  const growersQueryKey = referenceDataQueries.growers().queryKey;
  const growerProductsQueryKey = referenceDataQueries.growerProducts().queryKey;

  const growersQuery = useQuery(referenceDataQueries.growers());

  const contactDirectory = useContactPersonDirectory();

  // Names for the WhatsApp column's read view and for the search. Never waited
  // for, and never an error on this screen: without the list, the column shows
  // the stored ids as it always did (see useWhatsAppGroupNames).
  const whatsAppGroupNames = useWhatsAppGroupNames();

  // Every grower's in-season selection in ONE read (see
  // referenceDataQueries.growerProducts).
  const growerProductsQuery = useQuery(referenceDataQueries.growerProducts());

  // Every transporter, inactive ones too — the Transporters screen's own
  // entry. A grower can still be assigned one that was since made inactive
  // (the advice a refused delete gives), and its name must still show; only
  // the dropdown is limited to active ones (see the "מוביל" column).
  const transportersQuery = useQuery(referenceDataQueries.transporters());
  const transporterNameById = useMemo(
    () => new Map((transportersQuery.data ?? []).map((row) => [row.id, row.name])),
    [transportersQuery.data],
  );

  // The whole catalog for the in-season chips and picker — the same entry
  // the Users screen reads (useCatalogOptions).
  const {
    catalogQuery,
    families: catalogFamilies,
    labelById: varietyLabelById,
  } = useCatalogOptions();

  const editingRowId = editingId !== null && editingId !== NEW_ROW_ID ? editingId : null;
  const selected = growersQuery.data?.find((row) => row.id === editingRowId) ?? null;

  // Only patches an existing row — a brand-new grower (still unsaved,
  // editingId === NEW_ROW_ID) stays pessimistic: faking a row for an id the
  // server hasn't issued yet isn't worth the risk for a save that's
  // infrequent to begin with.
  const saveOptimistic = optimisticUpdate<GrowerCompany[], void>(
    queryClient,
    growersQueryKey,
    (rows) =>
      rows?.map((row) =>
        row.id === editingRowId
          ? {
              ...row,
              name: form.name,
              status: form.status,
              default_pickup_time: form.defaultPickupTime || null,
              whatsapp_group_id: form.whatsappGroupId || null,
              transporter_company_id: form.transporterCompanyId || null,
              contact_person_id: form.contactPersonId || null,
              no_arrangement_message: form.noArrangementMessage,
              ...toCompanyDetailsRow(form.details),
            }
          : row,
      ),
  );

  // The in-season list lives in its own query, so its optimistic patch is
  // its own too — without it, the row's "מוצרים בעונה" cell would snap back
  // to the pre-edit chips until the refetch lands.
  const saveProductsOptimistic = optimisticUpdate<Map<string, string[]>, void>(
    queryClient,
    growerProductsQueryKey,
    (byCompany) => {
      if (!byCompany || !editingRowId) return byCompany;
      const next = new Map(byCompany);
      next.set(editingRowId, [...form.productVarietyIds]);
      return next;
    },
  );

  const saveMutation = useMutation({
    mutationFn: async (): Promise<GrowerCompany> => {
      // Two active growers with one name can't be told apart in any list
      // (lib/company-name.ts). Checked before anything is written.
      if (
        activeNameTaken(growersQuery.data ?? [], {
          id: editingRowId,
          name: form.name,
          status: form.status,
        })
      ) {
        throw new Error("כבר יש מגדל פעיל בשם הזה. בחרו שם אחר.");
      }
      const input = saveGrowerInputSchema.parse({
        id: editingRowId,
        name: form.name,
        status: form.status,
        defaultPickupTime: form.defaultPickupTime || null,
        whatsappGroupId: form.whatsappGroupId || null,
        productVarietyIds: [...form.productVarietyIds],
        transporterCompanyId: form.transporterCompanyId || null,
        contactPersonId: form.contactPersonId || null,
        noArrangementMessage: form.noArrangementMessage,
        // Always all five, so an emptied box clears the stored value (0092).
        phone: form.details.phone,
        addressLine: form.details.addressLine,
        city: form.details.city,
        taxId: form.details.taxId,
        accountingId: form.details.accountingId,
      });
      const { data, error } = await supabase.rpc("save_grower", toSaveGrowerRpcArgs(input));
      if (error) throw error;
      return data;
    },
    onMutate: async (variables) => {
      const rows = await saveOptimistic.onMutate(variables);
      const products = await saveProductsOptimistic.onMutate(variables);
      return { rows, products };
    },
    onSuccess: () => {
      showToast("הנתונים נשמרו.", "success");
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: growersQueryKey });
      void queryClient.invalidateQueries({ queryKey: growerProductsQueryKey });
      invalidateGrowerReaders();
    },
    onError: (
      error: { message?: string },
      variables,
      context:
        | {
            rows: { previous: GrowerCompany[] | undefined } | undefined;
            products: { previous: Map<string, string[]> | undefined } | undefined;
          }
        | undefined,
    ) => {
      saveOptimistic.onError(error, variables, context?.rows);
      saveProductsOptimistic.onError(error, variables, context?.products);
      showToast(`השמירה נכשלה: ${errorMessage(error)}`, "error");
    },
  });

  const deleteOptimistic = optimisticUpdate<GrowerCompany[], void>(
    queryClient,
    growersQueryKey,
    (rows) => rows?.filter((row) => row.id !== deleteTargetId),
  );

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!deleteTargetId) return;
      // delete_grower (0108): the grower's picks that were never used (the
      // empty pick a grower added while a day is open gets) and its queued
      // messages go with it. A grower that really traded is refused as
      // before: "in use, make it inactive instead".
      const { error } = await supabase.rpc("delete_grower", {
        p_grower_company_id: deleteTargetId,
      });
      if (error) throw error;
    },
    onMutate: deleteOptimistic.onMutate,
    onSuccess: () => {
      showToast("המגדל נמחק.", "success");
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: growersQueryKey });
      invalidateGrowerReaders();
    },
    onError: mergeOnError(deleteOptimistic.onError, (error: { message?: string }) => {
      showToast(`המחיקה נכשלה: ${errorMessage(error)}`, "error");
      setDeleteTarget(null);
    }),
  });

  // The other screens that read these same grower rows under keys of their
  // own: "בשם מגדל" (its grower list, in-season lists and picks) and the two
  // user screens' company pickers. None is mounted here, so this only marks
  // them stale — reference data is out of live updates (migration 0061), and
  // without it they'd serve the pre-save copy for up to the 30 s staleTime.
  function invalidateGrowerReaders() {
    void queryClient.invalidateQueries({ queryKey: growerOversightKeys.all });
    invalidateCompanyPickers(queryClient);
  }

  // Seeded synchronously from data the table already has — the in-season
  // list is loaded up front for the column, not lazily on click, so there's
  // no window where the form is rendered but not yet filled (which is what
  // used to let a fast edit get overwritten by a late-arriving seed).
  function handleEditRow(row: GrowerCompany) {
    setEditingId(row.id);
    setForm(toFormState(row, growerProductsQuery.data?.get(row.id) ?? []));
  }

  function handleNew() {
    setEditingId(NEW_ROW_ID);
    setForm(BLANK_FORM);
  }

  function handleCancel() {
    setEditingId(null);
  }

  // What the form would hold with no unsaved edits — decides whether the
  // save button has anything to do. Computed from the live query data on
  // every render rather than frozen at seed time, so it always reflects the
  // actual current server state.
  const baselineForm = selected
    ? toFormState(selected, growerProductsQuery.data?.get(selected.id) ?? [])
    : BLANK_FORM;
  const dirty = hasChanges(form, baselineForm);

  function toggleProduct(id: string) {
    setForm((current) => {
      const next = new Set(current.productVarietyIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...current, productVarietyIds: next };
    });
  }

  function save() {
    setSaving(true);
    saveMutation.mutate(undefined, { onSettled: () => setSaving(false) });
  }

  // Before a save that takes varieties out of an existing grower's season,
  // the lines on today's pick still holding stock for them (workbook Task 04).
  // The save keeps those lines either way, so nothing is lost; the warning is
  // so a variety unticked by mistake is caught before the save. Read fresh at
  // this moment, because stock changes all day; a failed read saves nothing.
  async function handleSave() {
    const before = selected ? (growerProductsQuery.data?.get(selected.id) ?? []) : [];
    const removed = new Set(before.filter((id) => !form.productVarietyIds.has(id)));
    if (selected && removed.size > 0) {
      setSaving(true);
      try {
        const holding = linesHoldingStock(removed, await readSeasonStock(selected.id));
        if (holding.length > 0) {
          setStockWarning(holding);
          setSaving(false);
          return;
        }
      } catch (error) {
        showToast(`השמירה נכשלה: ${errorMessage(error as { message?: string })}`, "error");
        setSaving(false);
        return;
      }
    }
    save();
  }

  // "נקטפו 5 · עודף 2 · משובצים 1" — only what the line holds.
  function stockSummary(line: SeasonStockLine): string {
    return [
      line.picked > 0 ? `נקטפו ${formatPallets(line.picked)}` : null,
      line.leftover > 0 ? `עודף ${formatPallets(line.leftover)}` : null,
      line.arranged > 0 ? `משובצים ${formatPallets(line.arranged)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // טלפון, כתובת, יישוב and הנה״ח (migration 0092) — the same columns on all
  // three company screens (company-detail-columns.tsx).
  const detailColumns = buildCompanyDetailColumns<GrowerCompany>({
    details: form.details,
    onChange: (patch) =>
      setForm((current) => ({ ...current, details: { ...current.details, ...patch } })),
  });
  const columns: RecordTableColumn<GrowerCompany>[] = [
    {
      key: "name",
      label: "שם",
      render: (row) => <span className="font-medium text-ink">{row.name}</span>,
      renderEdit: () => (
        <input
          aria-label="שם"
          autoFocus
          required
          className={`${inputClassName} w-full min-w-[10rem]`}
          value={form.name}
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
        />
      ),
    },
    {
      key: "status",
      label: "סטטוס",
      render: (row) => (
        <StatusPill tone={row.status === "active" ? "accent" : "neutral"} dot>
          {row.status === "active" ? "פעיל" : "לא פעיל"}
        </StatusPill>
      ),
      renderEdit: () => (
        <Select
          aria-label="סטטוס"
          className="w-28"
          value={form.status}
          onChange={(next) => setForm((current) => ({ ...current, status: next }))}
          options={[
            { value: "active", label: "פעיל" },
            { value: "inactive", label: "לא פעיל" },
          ]}
        />
      ),
    },
    {
      key: "pickup",
      label: "שעת איסוף",
      render: (row) => row.default_pickup_time || "—",
      renderEdit: () => (
        <input
          type="time"
          aria-label="שעת איסוף ברירת מחדל"
          className={`${inputClassName} w-32`}
          value={form.defaultPickupTime}
          onChange={(event) =>
            setForm((current) => ({ ...current, defaultPickupTime: event.target.value }))
          }
        />
      ),
    },
    {
      key: "transporter",
      label: "מוביל",
      render: (row) =>
        row.transporter_company_id
          ? (transporterNameById.get(row.transporter_company_id) ?? "—")
          : "—",
      // Active transporters only, plus the one this grower is saved with
      // even if it has since been made inactive — shown by name rather than
      // as its raw id, and kept choosable after switching away from it.
      renderEdit: () => (
        <Select
          aria-label="מוביל"
          className="w-full min-w-[9rem]"
          value={form.transporterCompanyId}
          onChange={(next) =>
            setForm((current) => ({ ...current, transporterCompanyId: next }))
          }
          options={[
            { value: "", label: "— ללא —" },
            ...(transportersQuery.data ?? [])
              .filter(
                (transporter) =>
                  transporter.status === "active" ||
                  transporter.id === selected?.transporter_company_id,
              )
              .map((transporter) => ({ value: transporter.id, label: transporter.name })),
          ]}
        />
      ),
    },
    {
      // Bubble's "Should not receive arrangement?", the other way round: whether
      // this grower is sent the arrangement message (what was sold from its
      // stock, and to whom). Its transporter's pickup message goes out either way.
      key: "arrangementMessage",
      label: "הודעת סידור למגדל",
      render: (row) => (row.no_arrangement_message ? "לא נשלחת" : "נשלחת"),
      renderEdit: () => (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className={checkboxClassName}
            aria-label="הודעת סידור למגדל"
            checked={!form.noArrangementMessage}
            onChange={(event) =>
              setForm((current) => ({ ...current, noArrangementMessage: !event.target.checked }))
            }
          />
          {form.noArrangementMessage ? "לא נשלחת" : "נשלחת"}
        </label>
      ),
    },
    {
      key: "whatsapp",
      label: "קבוצת WhatsApp",
      render: (row) => <WhatsAppGroupSummary id={row.whatsapp_group_id} names={whatsAppGroupNames} />,
      renderEdit: () => (
        <WhatsAppGroupEditCell
          value={form.whatsappGroupId}
          onChange={(id) => setForm((current) => ({ ...current, whatsappGroupId: id }))}
        />
      ),
    },
    ...detailColumns.beforeContact,
    {
      key: "contactPerson",
      label: "איש קשר",
      render: (row) => (
        <ContactPersonSummary
          option={row.contact_person_id ? contactDirectory.optionById.get(row.contact_person_id) ?? null : null}
        />
      ),
      renderEdit: () => (
        <ContactPersonEditCell
          options={contactDirectory.options}
          selectedId={form.contactPersonId || null}
          onSelect={(id) => setForm((current) => ({ ...current, contactPersonId: id ?? "" }))}
        />
      ),
    },
    ...detailColumns.afterContact,
    {
      key: "inSeason",
      label: "מוצרים בעונה",
      render: (row) => (
        <CellChipList
          items={(growerProductsQuery.data?.get(row.id) ?? []).map(
            (id) => varietyLabelById.get(id) ?? id,
          )}
          emptyLabel="אין מוצרים בעונה"
        />
      ),
      renderEdit: () => (
        <ProductMultiSelectCell
          label="מוצרים בעונה"
          families={catalogFamilies}
          selectedIds={form.productVarietyIds}
          onToggle={toggleProduct}
        />
      ),
    },
    {
      key: "created",
      label: "נוצר",
      // Server-set, so read-only: no renderEdit.
      render: (row) =>
        row.created_at ? CREATED_AT_FORMAT.format(new Date(row.created_at)) : "—",
    },
  ];

  const rows =
    editingId === NEW_ROW_ID ? [blankRow(), ...(growersQuery.data ?? [])] : (growersQuery.data ?? []);

  return (
    <>
      <PageHeader title="מגדלים" subtitle="חברות מגדלים והמוצרים שבעונה אצל כל אחת." />
      <RecordTable
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        searchText={(row) => `${row.name} ${whatsAppGroupSearchText(row.whatsapp_group_id, whatsAppGroupNames)}`}
        editingId={editingId}
        savingEdit={saving}
        dirtyEdit={dirty}
        onEdit={handleEditRow}
        onSaveEdit={handleSave}
        onCancelEdit={handleCancel}
        onDelete={(row) => setDeleteTarget(row)}
        onAdd={handleNew}
        addLabel="מגדל חדש"
        // Waits for the in-season lists and the contact-person directory
        // too: both are columns now, and a table that paints rows before
        // they arrive would show every grower as having nothing in season
        // (or an unresolved contact) for a moment. The catalog and the
        // transporters name what those columns hold, so without them the
        // chips read as raw ids and every מוביל as "—".
        loading={
          growersQuery.isLoading ||
          growerProductsQuery.isLoading ||
          contactDirectory.isLoading ||
          catalogQuery.isLoading ||
          transportersQuery.isLoading
        }
        // Same reasoning as `loading` above, for the error path.
        loadError={
          (growersQuery.isError && !growersQuery.data) ||
          (growerProductsQuery.isError && !growerProductsQuery.data) ||
          (contactDirectory.isError && contactDirectory.options.length === 0) ||
          (catalogQuery.isError && catalogQuery.data === undefined) ||
          (transportersQuery.isError && transportersQuery.data === undefined)
            ? {
                what: "רשימת המגדלים",
                onRetry: () => {
                  void growersQuery.refetch();
                  void growerProductsQuery.refetch();
                  contactDirectory.refetch();
                  void catalogQuery.refetch();
                  void transportersQuery.refetch();
                },
                retrying:
                  growersQuery.isFetching ||
                  growerProductsQuery.isFetching ||
                  contactDirectory.isFetching ||
                  catalogQuery.isFetching ||
                  transportersQuery.isFetching,
              }
            : null
        }
        searchPlaceholder="חיפוש מגדל"
        emptyLabel="אין מגדלים עדיין."
      />

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="מחיקת מגדל">
        <p className="mb-4 text-sm">
          האם למחוק את המגדל &quot;{deleteTarget?.name}&quot;? פעולה זו אינה הפיכה.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
            ביטול
          </Button>
          <Button
            variant="danger"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? "מוחק…" : "מחק"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={stockWarning !== null}
        onClose={() => setStockWarning(null)}
        title="יש מלאי בזנים שיוצאים מהעונה"
      >
        <p className="mb-2 text-sm">לזנים האלה יש היום מלאי בליקוט של {form.name}:</p>
        <ul className="mb-3 list-disc space-y-1 ps-5 text-sm">
          {(stockWarning ?? []).map((line) => (
            <li key={line.varietyId}>
              <span className="font-medium">{varietyLabelById.get(line.varietyId) ?? line.varietyId}</span>
              {" — "}
              {stockSummary(line)}
            </li>
          ))}
        </ul>
        <p className="mb-4 text-sm text-ink-muted">
          המלאי של היום לא יימחק: השורות האלה נשארות בליקוט של היום.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setStockWarning(null)}>
            ביטול
          </Button>
          <Button
            onClick={() => {
              setStockWarning(null);
              save();
            }}
          >
            שמור בכל זאת
          </Button>
        </div>
      </Dialog>
    </>
  );
}
