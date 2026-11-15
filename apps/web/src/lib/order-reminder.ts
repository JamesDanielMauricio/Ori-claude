import { normalizePhoneNumber, toWhatsAppPersonalNumber } from "@ori/shared/phone";

// One person of a customer, as the reminder window shows them: whether the
// reminder can reach them, and if not, why. Reachability uses the same phone
// rule the database and the WhatsApp sender use, so the window never ticks
// someone the sender would silently skip.
export interface ReminderPerson {
  userId: string;
  name: string;
  // "•••" + the last four digits — enough to recognise a number, not to
  // read it out. Null when there is no readable number.
  phoneTail: string | null;
  canReceive: boolean;
  reason: "no_phone" | "invalid_phone" | null;
}

export function reminderPeople(
  rows: ReadonlyArray<{ user_id: string; display_name: string; phone_number: string | null }>,
): ReminderPerson[] {
  return rows
    .map((row): ReminderPerson => {
      const canReceive = toWhatsAppPersonalNumber(row.phone_number) !== null;
      const stored = normalizePhoneNumber(row.phone_number);
      const empty = !row.phone_number || row.phone_number.trim() === "";
      return {
        userId: row.user_id,
        name: row.display_name,
        phoneTail: stored ? `•••${stored.replace(/\D/g, "").slice(-4)}` : null,
        canReceive,
        reason: canReceive ? null : empty ? "no_phone" : "invalid_phone",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "he"));
}

// Everyone the reminder can reach starts ticked.
export function initiallyTicked(people: ReminderPerson[]): Set<string> {
  return new Set(people.filter((person) => person.canReceive).map((person) => person.userId));
}
