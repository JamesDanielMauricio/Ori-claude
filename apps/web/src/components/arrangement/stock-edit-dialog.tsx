import { savePickLinesInputSchema, toSavePickLinesRpcArgs } from "@ori/domain/grower";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";

import { inputClassName } from "@/components/reference-data/form-field";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { errorMessage } from "@/lib/error-message";
import { blockDecimalKey, blockWheel, stripDecimal } from "@/lib/integer-input";
import { arrangementQueries, type PickLineForEdit } from "@/lib/queries/arrangement";
import { stockEditCheck } from "@/lib/stock-edit";
import { createClient } from "@/lib/supabase/client";
import { formatVarietyName } from "@/lib/variety-label";

import { formatPallets } from "./board-data";

// The quick stock edit ("עדכון מלאי"): one pick line's two stock numbers,
// changed without opening the grower's whole pick. Props only — it imports
// nothing from the arrangement grid, so any screen that can name a pick line
// can open it.
//
// What is edited is read fresh each time it opens (arrangementQueries
// .pickLineForEdit): the numbers, the line's comment and what is arranged
// off it. Saving goes through save_pick_lines like the grower's own editor,
// with just this one line — the function updates only the lines it is sent.
// It writes the comment back along with the numbers, which is why the fresh
// comment is sent too, rather than an empty one.
//
// A refusal (someone arranged more pallets meanwhile, the pick was closed)
// is shown inside the dialog, which stays open; closing and reopening reads
// the line again.
export function StockEditDialog({
  pickLineId,
  onClose,
  onSaved,
}: {
  pickLineId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const query = useQuery(arrangementQueries.pickLineForEdit(pickLineId));
  const line = query.data;

  return (
    <Dialog
      open={pickLineId !== null}
      onClose={onClose}
      title={
        line
          ? `עדכון מלאי — ${line.growerName} · ${formatVarietyName(line.varietyName, line.sizes)}`
          : "עדכון מלאי"
      }
    >
      {line ? (
        // Keyed by the line, so the boxes start from this opening's read.
        <StockEditForm key={line.id} line={line} onClose={onClose} onSaved={onSaved} />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(query.error)}
        </p>
      ) : (
        <p className="text-sm text-ink-muted">טוען…</p>
      )}
    </Dialog>
  );
}

function StockEditForm({
  line,
  onClose,
  onSaved,
}: {
  line: PickLineForEdit;
  onClose: () => void;
  onSaved: () => void;
}) {
  const pickedId = useId();
  const leftoverId = useId();
  const [picked, setPicked] = useState(String(line.palletsPicked));
  const [leftover, setLeftover] = useState(String(line.leftoverPallets));

  const check = stockEditCheck({ picked, leftover, arranged: line.arranged });
  // The pick can be closed (the truck icon) between the grid drawing the
  // button and this read. save_pick_lines would refuse it anyway; saying so
  // up front, from the fresh read, beats offering a button that cannot work.
  const closed = line.status === "closed";

  const save = useMutation({
    mutationFn: async (numbers: { picked: number; leftover: number }) => {
      const input = savePickLinesInputSchema.parse({
        dailyPickId: line.dailyPickId,
        lines: [
          {
            dailyPickProductId: line.id,
            palletsPicked: numbers.picked,
            leftoverPallets: numbers.leftover,
            comment: line.comment,
          },
        ],
      });
      const { error } = await createClient().rpc("save_pick_lines", toSavePickLinesRpcArgs(input));
      if (error) throw error;
    },
    onSuccess: onSaved,
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (check.ok && !closed && !save.isPending) save.mutate(check);
      }}
    >
      <div className="flex gap-4">
        <StockBox id={pickedId} label="משטחים מהיום:" value={picked} onChange={setPicked} />
        <StockBox id={leftoverId} label="מלאי קודם:" value={leftover} onChange={setLeftover} />
      </div>

      <p className="text-sm text-ink-muted">כבר סודרו: {formatPallets(line.arranged)}</p>

      {closed ? (
        <Alert>הליקוט סגור, ואי אפשר לשנות אותו.</Alert>
      ) : save.isError ? (
        <Alert>{errorMessage(save.error)}</Alert>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          ביטול
        </Button>
        <Button type="submit" disabled={!check.ok || closed || save.isPending}>
          {save.isPending ? "שומר…" : "אישור"}
        </Button>
      </div>
    </form>
  );
}

// The grower's pick boxes' input rules (pick-lines-editor.tsx NumberCell):
// whole numbers only, and the wheel cannot nudge a focused box.
function StockBox({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min="0"
        step="1"
        className={`${inputClassName} w-full`}
        value={value}
        onKeyDown={blockDecimalKey}
        onWheel={blockWheel}
        onChange={(event) => onChange(stripDecimal(event.target.value))}
      />
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger ring-1 ring-inset ring-danger/20"
    >
      <Icon name="alertCircle" className="mt-px h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
