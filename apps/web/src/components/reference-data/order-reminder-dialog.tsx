import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { initiallyTicked, reminderPeople, type ReminderPerson } from "@/lib/order-reminder";
import { oversightQueries } from "@/lib/queries/oversight";

const REASON_TEXT = { no_phone: "אין טלפון", invalid_phone: "מספר לא תקין" } as const;

// The window behind a customer's bell: who the order reminder goes to. Every
// person with a number WhatsApp can use starts ticked; the office unticks
// anyone who should not get it. The server re-checks the list (a person who
// left the customer in the meantime is refused), so this is a convenience,
// not the safeguard.
export function OrderReminderDialog({
  target,
  onClose,
  sending,
  onSend,
  error,
}: {
  target: { dailyOrderId: string; customerId: string; customerName: string } | null;
  onClose: () => void;
  sending: boolean;
  onSend: (recipientUserIds: string[]) => void;
  // A refusal of the last send, already in Hebrew; shown inside the window,
  // which stays open.
  error: string | null;
}) {
  const peopleQuery = useQuery(oversightQueries.customerPeople(target?.customerId ?? null));
  const people = peopleQuery.data ? reminderPeople(peopleQuery.data) : null;

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={`שליחת תזכורת — ${target?.customerName ?? ""}`}
    >
      {people ? (
        // Keyed by the list's makeup, so a re-read that changes who can
        // receive starts the ticks over instead of keeping stale ones.
        <ReminderForm
          key={people.map((p) => `${p.userId}:${p.canReceive}`).join("|")}
          people={people}
          sending={sending}
          error={error}
          onClose={onClose}
          onSend={onSend}
        />
      ) : peopleQuery.isError ? (
        <p role="alert" className="text-sm text-danger">
          טעינת אנשי הלקוח נכשלה.{" "}
          <button type="button" className="underline" onClick={() => void peopleQuery.refetch()}>
            נסו שוב
          </button>
        </p>
      ) : (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
    </Dialog>
  );
}

function ReminderForm({
  people,
  sending,
  error,
  onClose,
  onSend,
}: {
  people: ReminderPerson[];
  sending: boolean;
  error: string | null;
  onClose: () => void;
  onSend: (recipientUserIds: string[]) => void;
}) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => initiallyTicked(people));
  const anyoneReachable = people.some((person) => person.canReceive);
  const chosen = people.filter((person) => ticked.has(person.userId) && person.canReceive);

  function toggle(userId: string) {
    setTicked((current) => {
      const next = new Set(current);
      if (!next.delete(userId)) next.add(userId);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {!anyoneReachable && (
        <p className="text-sm text-ink">
          לאף אחד מאנשי הלקוח אין מספר טלפון שאפשר לשלוח אליו הודעת WhatsApp. אפשר להוסיף מספר
          במסך המשתמשים.
        </p>
      )}
      {people.length > 0 && (
        <>
          <p className="text-sm font-semibold text-ink">מקבלי ההודעה:</p>
          <ul className="space-y-1">
            {people.map((person) => (
              <li key={person.userId}>
                <label
                  className={`flex min-h-10 items-center gap-3 rounded-md px-2 text-sm ${
                    person.canReceive ? "cursor-pointer hover:bg-surface-muted" : "text-ink-subtle"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-accent"
                    checked={ticked.has(person.userId) && person.canReceive}
                    disabled={!person.canReceive}
                    onChange={() => toggle(person.userId)}
                  />
                  <span className="min-w-0 flex-1 break-words">{person.name}</span>
                  <span className="shrink-0 text-xs text-ink-subtle">
                    {person.reason ? (
                      REASON_TEXT[person.reason]
                    ) : (
                      <bdi dir="ltr">{person.phoneTail}</bdi>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          ביטול
        </Button>
        <Button
          type="button"
          disabled={sending || chosen.length === 0}
          onClick={() => onSend(chosen.map((person) => person.userId))}
        >
          {sending ? "שולח…" : "שלח"}
        </Button>
      </div>
    </div>
  );
}
