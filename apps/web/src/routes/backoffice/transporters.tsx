import { saveTransporterInputSchema, toSaveTransporterRpcArgs } from "@ori/domain/reference-data";
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
import { inputClassName } from "@/components/reference-data/form-field";
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
import {
  invalidateCompanyPickers,
  referenceDataQueries,
  type TransporterCompany,
} from "@/lib/queries/reference-data";
import { createClient } from "@/lib/supabase/client";
import { useContactPersonDirectory } from "@/lib/use-contact-person-directory";

interface FormState {
  name: string;
  status: "active" | "inactive";
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
  whatsappGroupId: "",
  contactPersonId: "",
  details: BLANK_COMPANY_DETAILS,
};

function blankRow(): TransporterCompany {
  return {
    id: NEW_ROW_ID,
    name: "",
    status: "active",
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

function toFormState(row: TransporterCompany): FormState {
  return {
    name: row.name,
    status: row.status,
    whatsappGroupId: row.whatsapp_group_id ?? "",
    contactPersonId: row.contact_person_id ?? "",
    details: toCompanyDetailsForm(row),
  };
}

// The Transporters management screen — directory only. Per the PRD, a
// Transporter is a WhatsApp-only recipient with no in-app login of its
// own (see docs/SCHEMA_DECISIONS.md's user_role enum note), so this
// screen's record is just enough to address outbound dispatch, not an
// account.
export default function TransportersPage() {
  const supabase = createClient();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(BLANK_FORM);
  const [saving, setSaving] = useState(false);
  // Separate from `editingId` — deleting a row is still a confirm dialog,
  // not inline, so it needs its own target rather than reusing edit state.
  // The row itself, not its id: the optimistic delete takes it out of the
  // cache while the dialog is still naming it.
  const [deleteTarget, setDeleteTarget] = useState<TransporterCompany | null>(null);
  const deleteTargetId = deleteTarget?.id ?? null;

  const transportersQueryKey = referenceDataQueries.transporters().queryKey;

  const transportersQuery = useQuery(referenceDataQueries.transporters());

  const contactDirectory = useContactPersonDirectory();

  // Names for the WhatsApp column's read view and for the search. Never waited
  // for, and never an error on this screen: without the list, the column shows
  // the stored ids as it always did (see useWhatsAppGroupNames).
  const whatsAppGroupNames = useWhatsAppGroupNames();

  const editingRowId = editingId !== null && editingId !== NEW_ROW_ID ? editingId : null;
  const selected = transportersQuery.data?.find((row) => row.id === editingRowId) ?? null;

  const saveOptimistic = optimisticUpdate<TransporterCompany[], void>(
    queryClient,
    transportersQueryKey,
    (rows) =>
      rows?.map((row) =>
        row.id === editingRowId
          ? {
              ...row,
              name: form.name,
              status: form.status,
              whatsapp_group_id: form.whatsappGroupId || null,
              contact_person_id: form.contactPersonId || null,
              ...toCompanyDetailsRow(form.details),
            }
          : row,
      ),
  );

  const saveMutation = useMutation({
    mutationFn: async (): Promise<TransporterCompany> => {
      // Two active transporters with one name can't be told apart in any list
      // (lib/company-name.ts). Checked before anything is written.
      if (
        activeNameTaken(transportersQuery.data ?? [], {
          id: editingRowId,
          name: form.name,
          status: form.status,
        })
      ) {
        throw new Error("כבר יש מוביל פעיל בשם הזה. בחרו שם אחר.");
      }
      const input = saveTransporterInputSchema.parse({
        id: editingRowId,
        name: form.name,
        status: form.status,
        whatsappGroupId: form.whatsappGroupId || null,
        contactPersonId: form.contactPersonId || null,
        // Always all five, so an emptied box clears the stored value (0092).
        phone: form.details.phone,
        addressLine: form.details.addressLine,
        city: form.details.city,
        taxId: form.details.taxId,
        accountingId: form.details.accountingId,
      });
      const { data, error } = await supabase.rpc(
        "save_transporter",
        toSaveTransporterRpcArgs(input),
      );
      if (error) throw error;
      return data;
    },
    onMutate: saveOptimistic.onMutate,
    onSuccess: () => {
      showToast("הנתונים נשמרו.", "success");
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: transportersQueryKey });
      invalidateCompanyPickers(queryClient);
    },
    onError: mergeOnError(saveOptimistic.onError, (error: { message?: string }) => {
      showToast(`השמירה נכשלה: ${errorMessage(error)}`, "error");
    }),
  });

  const deleteOptimistic = optimisticUpdate<TransporterCompany[], void>(
    queryClient,
    transportersQueryKey,
    (rows) => rows?.filter((row) => row.id !== deleteTargetId),
  );

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!deleteTargetId) return;
      const { error } = await supabase.from("companies").delete().eq("id", deleteTargetId);
      if (error) throw error;
    },
    onMutate: deleteOptimistic.onMutate,
    onSuccess: () => {
      showToast("המוביל נמחק.", "success");
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: transportersQueryKey });
      invalidateCompanyPickers(queryClient);
    },
    onError: mergeOnError(deleteOptimistic.onError, (error: { message?: string }) => {
      showToast(`המחיקה נכשלה: ${errorMessage(error)}`, "error");
      setDeleteTarget(null);
    }),
  });

  function handleEditRow(row: TransporterCompany) {
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
  // server has it. Decides whether the save button has anything to do.
  const baselineForm = selected ? toFormState(selected) : BLANK_FORM;
  const dirty = hasChanges(form, baselineForm);

  function handleSave() {
    setSaving(true);
    saveMutation.mutate(undefined, { onSettled: () => setSaving(false) });
  }

  // טלפון, כתובת, יישוב and הנה״ח (migration 0092) — the same columns on all
  // three company screens (company-detail-columns.tsx).
  const detailColumns = buildCompanyDetailColumns<TransporterCompany>({
    details: form.details,
    onChange: (patch) =>
      setForm((current) => ({ ...current, details: { ...current.details, ...patch } })),
  });
  const columns: RecordTableColumn<TransporterCompany>[] = [
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
    editingId === NEW_ROW_ID
      ? [blankRow(), ...(transportersQuery.data ?? [])]
      : (transportersQuery.data ?? []);

  return (
    <>
      <PageHeader title="מובילים" subtitle="חברות הובלה — נמען WhatsApp בלבד, ללא התחברות למערכת." />
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
        addLabel="מוביל חדש"
        // Waits for the contact-person directory too: it's a column now,
        // and a table that paints rows before it arrives would show every
        // transporter as having no contact for a moment.
        loading={transportersQuery.isLoading || contactDirectory.isLoading}
        loadError={
          (transportersQuery.isError && !transportersQuery.data) ||
          (contactDirectory.isError && contactDirectory.options.length === 0)
            ? {
                what: "רשימת המובילים",
                onRetry: () => {
                  void transportersQuery.refetch();
                  contactDirectory.refetch();
                },
                retrying: transportersQuery.isFetching || contactDirectory.isFetching,
              }
            : null
        }
        searchPlaceholder="חיפוש מוביל"
        emptyLabel="אין מובילים עדיין."
      />

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="מחיקת מוביל">
        <p className="mb-4 text-sm">
          האם למחוק את המוביל &quot;{deleteTarget?.name}&quot;? פעולה זו אינה הפיכה.
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
