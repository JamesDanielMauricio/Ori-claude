import { setPickPickupTimeInputSchema, toSetPickPickupTimeRpcArgs } from "@ori/domain/grower";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { inputClassName } from "@/components/reference-data/form-field";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { errorMessage } from "@/lib/error-message";
import { toTimeInputValue } from "@/lib/pickup-time";
import { createClient } from "@/lib/supabase/client";

// The grower changes the day's pickup time ("שעת איסוף") on their own pick.
// `current` is the time the strip is showing: the pick's own time, or the
// company's default while the pick has none (lib/pickup-time).
//
// The form is rendered only while the dialog is open, so each opening starts
// from the current time and from a clean mutation state, not from what was
// typed or refused last time.
//
// A refusal (the office closed the pick meanwhile, the pick is not this
// grower's) is shown inside the dialog, which stays open. The server decides;
// this screen does not try to guess whether the pick is still open.
export function PickupTimeDialog({
  pickId,
  current,
  open,
  onClose,
  onSaved,
}: {
  pickId: string;
  current: string | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="שעת איסוף">
      {open && <PickupTimeForm pickId={pickId} current={current} onClose={onClose} onSaved={onSaved} />}
    </Dialog>
  );
}

function PickupTimeForm({
  pickId,
  current,
  onClose,
  onSaved,
}: {
  pickId: string;
  current: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(toTimeInputValue(current));

  const save = useMutation({
    mutationFn: async (pickupTime: string) => {
      const input = setPickPickupTimeInputSchema.parse({ dailyPickId: pickId, pickupTime });
      const { error } = await createClient().rpc("set_pick_pickup_time", toSetPickPickupTimeRpcArgs(input));
      if (error) throw error;
    },
    onSuccess: onSaved,
  });

  // An empty box (the browser's own clear button) is not a time: the server
  // refuses it, so it never gets that far, and שמור stays off.
  const canSave = value !== "" && !save.isPending;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) save.mutate(value);
      }}
    >
      {/* No visible label: the dialog's title already says what the box is. */}
      <input
        type="time"
        step="60"
        aria-label="שעת איסוף"
        className={`${inputClassName} w-full`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />

      {save.isError && (
        <p
          role="alert"
          className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger ring-1 ring-inset ring-danger/20"
        >
          <Icon name="alertCircle" className="mt-px h-4 w-4 shrink-0" />
          <span>{errorMessage(save.error)}</span>
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          ביטול
        </Button>
        <Button type="submit" disabled={!canSave}>
          {save.isPending ? "שומר…" : "שמור"}
        </Button>
      </div>
    </form>
  );
}
