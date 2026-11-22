import { saveCustomerInputSchema, toSaveCustomerRpcArgs } from "@ori/domain/reference-data";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { buildCompanyDetailColumns } from "@/components/reference-data/company-detail-columns";
import {
  BLANK_COMPANY_DETAILS,
  toCompanyDetailsForm,
  toCompanyDetailsRow,
  type CompanyDetailsForm,
} from "@/components/reference-data/company-details";
import { ContactPersonEditCell, ContactPersonSummary } from "@/components/reference-data/contact-person-cell";
import { checkboxClassName, inputClassName } from "@/components/reference-data/form-field";
import { RecordTable, type RecordTableColumn } from "@/components/reference-data/record-table";
import {
  useWhatsAppGroupNames,
  WhatsAppGroupEditCell,
  WhatsAppGroupSummary,
  whatsAppGroupSearchText,
} from "@/components/reference-data/whatsapp-group-cell";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { StatusPill } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { activeNameTaken } from "@/lib/company-name";
import { errorMessage } from "@/lib/error-message";
import { hasChanges } from "@/lib/has-changes";
import { mergeOnError, optimisticUpdate } from "@/lib/optimistic-mutation";
import { oversightQueries } from "@/lib/queries/oversight";
import {
  invalidateCompanyPickers,
  referenceDataQueries,
  type CustomerCompany,
} from "@/lib/queries/reference-data";
import { createClient } from "@/lib/supabase/client";
import { useContactPersonDirectory } from "@/lib/use-contact-person-directory";

interface FormState {
  name: string;
  status: "active" | "inactive";
  canSeeProductPrices: boolean;
  whatsappGroupId: string;
  contactPersonId: string;
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
  canSeeProductPrices: false,
  whatsappGroupId: "",
  contactPersonId: "",
  details: BLANK_COMPANY_DETAILS,
};

// Field values here are never actually read: every column either has a
// `renderEdit` for the draft row or (נוצר) checks for the draft row's id
// itself. Only `id` matters — for that, for keying, and for RecordTable's
// search-bypass.
function blankRow(): CustomerCompany {
  return {
    id: NEW_ROW_ID,
    name: "",
    status: "active",
    can_see_product_prices: false,
    whatsapp_group_id: null,
    contact_person_id: null,
    phone: null,
    address_line: null,
    city: null,
    tax_id: null,
    accounting_id: null,
    created_at: "",
  };
}

function toFormState(row: CustomerCompany): FormState {
  return {
    name: row.name,
    status: row.status,
    canSeeProductPrices: row.can_see_product_prices ?? false,
    whatsappGroupId: row.whatsapp_group_id ?? "",
    contactPersonId: row.contact_person_id ?? "",
    details: toCompanyDetailsForm(row),
  };
}

// The Customers management screen (PRD: "Customer companies"). `save_customer`
// is a single-row save — still an RPC, not a plain `.update()`, for the
// same reason every screen in this module goes through one: one call site
// for the backoffice-only check, and a consistent client pattern across
// all five screens (see packages/db/migrations/0007).
export default function CustomersPage() {
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
  const [deleteTarget, setDeleteTarget] = useState<CustomerCompany | null>(null);
  const deleteTargetId = deleteTarget?.id ?? null;

  const customersQueryKey = referenceDataQueries.customers().queryKey;

  const customersQuery = useQuery(referenceDataQueries.customers());

  const contactDirectory = useContactPersonDirectory();

  // Names for the WhatsApp column's read view and for the search. Never waited
  // for, and never an error on this screen: without the list, the column shows
  // the stored ids as it always did (see useWhatsAppGroupNames).
  const whatsAppGroupNames = useWhatsAppGroupNames();

  const editingRowId = editingId === NEW_ROW_ID ? null : editingId;
  const selected = customersQuery.data?.find((row) => row.id === editingRowId) ?? null;

  const saveOptimistic = optimisticUpdate<CustomerCompany[], void>(
    queryClient,
    customersQueryKey,
    (rows) =>
      rows?.map((row) =>
        row.id === editingRowId
          ? {
              ...row,
              name: form.name,
              status: form.status,
              can_see_product_prices: form.canSeeProductPrices,
              whatsapp_group_id: form.whatsappGroupId || null,
              contact_person_id: form.contactPersonId || null,
              ...toCompanyDetailsRow(form.details),
            }
          : row,
      ),
  );

  const saveMutation = useMutation({
    mutationFn: async (): Promise<CustomerCompany> => {
      // Two active customers with one name can't be told apart in any list
      // (lib/company-name.ts). Checked before anything is written.
      if (
        activeNameTaken(customersQuery.data ?? [], {
          id: editingRowId,
          name: form.name,
          status: form.status,
        })
      ) {
        throw new Error("כבר יש לקוח פעיל בשם הזה. בחרו שם אחר.");
      }
      const input = saveCustomerInputSchema.parse({
        id: editingRowId,
        name: form.name,
        status: form.status,
        canSeeProductPrices: form.canSeeProductPrices,
        whatsappGroupId: form.whatsappGroupId || null,
        contactPersonId: form.contactPersonId || null,
        // Always all five, so an emptied box clears the stored value (0092).
        phone: form.details.phone,
        addressLine: form.details.addressLine,
        city: form.details.city,
        taxId: form.details.taxId,
        accountingId: form.details.accountingId,
      });
      const { data, error } = await supabase.rpc("save_customer", toSaveCustomerRpcArgs(input));
      if (error) throw error;
      return data;
    },
    onMutate: saveOptimistic.onMutate,
    onSuccess: () => {
      showToast("הנתונים נשמרו.", "success");
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: customersQueryKey });
      invalidateCustomerReaders();
    },
    onError: mergeOnError(saveOptimistic.onError, (error: { message?: string }) => {
      showToast(`השמירה נכשלה: ${errorMessage(error)}`, "error");
    }),
  });

  const deleteOptimistic = optimisticUpdate<CustomerCompany[], void>(
    queryClient,
    customersQueryKey,
    (rows) => rows?.filter((row) => row.id !== deleteTargetId),
  );

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!deleteTargetId) return;
      // delete_customer (0098): the customer's never-placed orders (the empty
      // header a customer added while the shop is open gets) and its queued
      // messages go with it. A customer that really ordered is refused as
      // before: "in use, make it inactive instead".
      const { error } = await supabase.rpc("delete_customer", { p_customer_company_id: deleteTargetId });
      if (error) throw error;
    },
    onMutate: deleteOptimistic.onMutate,
    onSuccess: () => {
      showToast("הלקוח נמחק.", "success");
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: customersQueryKey });
      invalidateCustomerReaders();
    },
    onError: mergeOnError(deleteOptimistic.onError, (error: { message?: string }) => {
      showToast(`המחיקה נכשלה: ${errorMessage(error)}`, "error");
      setDeleteTarget(null);
    }),
  });

  // The other screens that list these same customers under keys of their
  // own: "בשם לקוח" and the two user screens' company pickers. Not mounted
  // here, so this only marks them stale (see growers.tsx's identical note).
  function invalidateCustomerReaders() {
    void queryClient.invalidateQueries({ queryKey: oversightQueries.activeCustomers().queryKey });
    invalidateCompanyPickers(queryClient);
  }

  // No second, lazily-fetched query behind this form (unlike growers/products/
  // users), so — unlike those three — the row already fetched is the whole
  // baseline: seeding can happen synchronously in the click handler instead
  // of needing an effect to wait for anything.
  function handleEditRow(row: CustomerCompany) {
    setEditingId(row.id);
    setForm(toFormState(row));
  }

  function handleNew() {
    setEditingId(NEW_ROW_ID);
    setForm(BLANK_FORM);
  }

  function handleCancel() {
    setEditingId(null);
  }

  // What the form would hold with no unsaved edits: this record as the
  // server has it. Used both for "בטל שינויים" and for deciding whether
  // either button has anything to do.
  const baselineForm = selected ? toFormState(selected) : BLANK_FORM;
  const dirty = hasChanges(form, baselineForm);

  function handleSave() {
    setSaving(true);
    saveMutation.mutate(undefined, { onSettled: () => setSaving(false) });
  }

  // טלפון, כתובת, יישוב and הנה״ח (migration 0092) — the same columns on all
  // three company screens (company-detail-columns.tsx).
  const detailColumns = buildCompanyDetailColumns<CustomerCompany>({
    details: form.details,
    onChange: (patch) =>
      setForm((current) => ({ ...current, details: { ...current.details, ...patch } })),
  });
  const columns: RecordTableColumn<CustomerCompany>[] = [
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
      key: "prices",
      label: "מציג מחירים בהתראות",
      render: (row) => (row.can_see_product_prices ? "כן" : "לא"),
      renderEdit: () => (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className={checkboxClassName}
            aria-label="מציג מחירים בהתראות"
            checked={form.canSeeProductPrices}
            onChange={(event) =>
              setForm((current) => ({ ...current, canSeeProductPrices: event.target.checked }))
            }
          />
          {form.canSeeProductPrices ? "כן" : "לא"}
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
      key: "created",
      label: "נוצר",
      // Server-set, so read-only: no renderEdit.
      render: (row) =>
        row.created_at ? CREATED_AT_FORMAT.format(new Date(row.created_at)) : "—",
    },
  ];

  const rows =
    editingId === NEW_ROW_ID ? [blankRow(), ...(customersQuery.data ?? [])] : (customersQuery.data ?? []);

  return (
    <>
      <PageHeader title="לקוחות" subtitle="חברות לקוחות והגדרת הצגת מחירים לכל אחת." />
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
        addLabel="לקוח חדש"
        // Waits for the contact-person directory too: it's a column now,
        // and a table that paints rows before it arrives would show every
        // customer as having no contact for a moment.
        loading={customersQuery.isLoading || contactDirectory.isLoading}
        loadError={
          (customersQuery.isError && !customersQuery.data) ||
          (contactDirectory.isError && contactDirectory.options.length === 0)
            ? {
                what: "רשימת הלקוחות",
                onRetry: () => {
                  void customersQuery.refetch();
                  contactDirectory.refetch();
                },
                retrying: customersQuery.isFetching || contactDirectory.isFetching,
              }
            : null
        }
        searchPlaceholder="חיפוש לקוח"
        emptyLabel="אין לקוחות עדיין."
      />

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="מחיקת לקוח">
        <p className="mb-4 text-sm">
          האם למחוק את הלקוח &quot;{deleteTarget?.name}&quot;? פעולה זו אינה הפיכה.
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
    </>
  );
}
