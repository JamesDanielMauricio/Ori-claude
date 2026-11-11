import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";

// The "מגדל מועדף" chooser (workbook Task 36): the growers that have this
// variety in stock today, by name, and "ללא העדפה". The same confirm/dismiss
// gate as CommentPopup, because it does the same thing — "אישור" writes into
// the caller's draft of the line's comment, never to the server; that happens
// only when the whole order is sent, as with every line comment.
//
// Real radio buttons rather than a list of buttons that act on a tap: arrow
// keys move a radio group's choice, and a choice that closed the dialog would
// close it on the first arrow press.
export function PreferredGrowerDialog({
  open,
  varietyName,
  growers,
  initialChoice,
  hasQuantity,
  onClose,
  onConfirm,
}: {
  open: boolean;
  // Which product the choice is for, shown at the top: the dialog covers the
  // row it was opened from.
  varietyName: string;
  growers: readonly string[];
  // What to start on: a grower's name, null for "ללא העדפה", or undefined
  // when the comment names a grower who is not among `growers` — then nothing
  // is chosen until the customer chooses (preferred-grower.ts's
  // initialGrowerChoice).
  initialChoice: string | null | undefined;
  // Whether the line has a quantity. A line comment is saved only with one
  // (submit_order skips a line of 0 pallets), so without it the note below
  // says so.
  hasQuantity: boolean;
  onClose: () => void;
  // The grower chosen, or null for "ללא העדפה".
  onConfirm: (growerName: string | null) => void;
}) {
  const [choice, setChoice] = useState(initialChoice);
  const groupName = useId();

  // Back to what the comment says every time it opens, as CommentPopup does.
  // `initialChoice` is a plain value (a name, null or undefined), never a new
  // array, so a live refetch that brings the same names does not reset a
  // choice in progress.
  useEffect(() => {
    if (open) setChoice(initialChoice);
  }, [open, initialChoice]);

  const options: Array<{ value: string | null; label: string }> = [
    { value: null, label: "ללא העדפה" },
    ...growers.map((name) => ({ value: name, label: name })),
  ];

  return (
    <Dialog open={open} onClose={onClose} title="מגדל מועדף">
      <div className="flex flex-col gap-4">
        {/* A plain fieldset, not a flex one: a legend inside a flex
            fieldset is laid out differently from browser to browser. */}
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">{varietyName}</legend>
          {/* Rows, tinted when chosen, as CheckboxList's: in a list of
              similar names a 16px dot at the start of the line is easy to
              lose. Each row is the whole label, so the tap target is the
              row and not the dot. */}
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-lg bg-surface-muted/60 p-2 ring-1 ring-inset ring-border">
            {options.map((option) => {
              const checked = choice === option.value;
              return (
                <label
                  key={option.value ?? ""}
                  className={`flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors ${
                    checked ? "bg-accent-soft font-medium text-accent" : "text-ink hover:bg-surface"
                  }`}
                >
                  <input
                    type="radio"
                    name={groupName}
                    checked={checked}
                    onChange={() => setChoice(option.value)}
                  />
                  <span className="min-w-0 break-words">{option.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {hasQuantity ? (
          <p className="text-xs text-ink-muted">
            ההעדפה נכתבת בהערה של המוצר, ונשמרת יחד עם הכמות בלחיצה על "שמור".
          </p>
        ) : (
          <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-xs text-warning ring-1 ring-inset ring-warning/20">
            <Icon name="alertCircle" className="h-4 w-4 shrink-0" />
            <span>ההעדפה נשמרת רק יחד עם כמות — יש להזין כמות למוצר הזה.</span>
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            ביטול
          </Button>
          <Button
            type="button"
            disabled={choice === undefined}
            onClick={() => {
              if (choice === undefined) return;
              onConfirm(choice);
              onClose();
            }}
          >
            אישור
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
