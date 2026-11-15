# Bubble feature gaps — design

**Date:** 2026-11-15 · **Status:** for James's review · **Branch:** `feat/bubble-feature-gaps` (not created yet)

## 1. Why

A read-only comparison of Bubble's live app (`uri-and-the-bananas`) with Ori on
2026-11-14 found seven things the office or the growers can do in Bubble and
cannot do in Ori. James asked for all seven to be added before the switch-over,
"safely — make sure nothing will get broken". Columns were already matched on
2026-11-10 (`2026-11-10-bubble-column-parity-design.md`); this is about
behaviour.

## 2. Goals

| # | Feature | Where |
|---|---|---|
| 1 | Status filter | בשם מגדל, בשם לקוח |
| 2 | "X מתוך Y" counter | בשם מגדל, בשם לקוח |
| 3 | The office chooses which of a customer's people get the order reminder | the bell on בשם לקוח |
| 4 | The office changes a user's login email | משתמשים |
| 5 | The same order-reminder bell on each customer card | סידור |
| 6 | Quick edit of a grower's stock (today's pallets and previous stock) | סידור לפי מוצרים, מוצרים שנקטפו |
| 7 | A grower changes the day's pickup time | the grower's own picking screen |

Done means: each feature works as described below, and everything that works
today still works the same way (section 9 says how that is proven).

## 3. Non-goals

- Changing who receives any other WhatsApp message. Bubble routes some
  messages differently from Ori (found 2026-11-15, see section 10). That is a
  separate list for James to decide on later.
- A user changing their own email on the profile screen (left out on purpose
  before: there is no verification step).
- The office changing a grower's pickup time for one day (Bubble has no such
  control either; the company default on מגדלים stays the office's tool).
- Editing stock on מוצרים שנקטפו for a product that several growers supply
  (as in Bubble: that cell stays a sum, and the matrix is where each grower's
  line is edited).
- Remembering the chosen filter between visits.
- Any change to Bubble. Read-only checks only (standing rule).

## 4. Anti-goals — failures even if the feature "works"

- Any existing WhatsApp message reaching different people than today.
- A reminder sent to a WhatsApp group, or to someone outside that customer.
- The grid's "שמור שינויים" (migration 0103) changing in any way, or unsaved
  grid changes being lost when stock is edited.
- A stock edit that goes below what is already arranged.
- A grower who never chose a time getting a different pickup time than today,
  on any screen or in the transporter's message.
- An email change that sends the person a confirmation email, signs them out,
  or leaves two accounts able to use one address.

## 5. Constraints

- **Migrations are files only.** James runs them (`packages/db/migrations`,
  each added to `meta/_journal.json`). An applied migration is never edited.
  Live is at 0103 (checked 2026-11-15: 0101, 0102, 0103 all applied).
- **Old browser tabs keep working.** Every changed database function accepts
  the calls today's website makes, unchanged.
- **The WhatsApp sender (`whatsapp-dispatch`) is not redeployed.** It reads
  recipients only through `resolve_outbox_dispatch(uuid) returns table(target
  text, is_group boolean, message text)`; that signature stays. It also calls
  `claim_outbox_rows`, `settle_outbox_row` and `record_outbox_target_sent`,
  which are untouched.
- **Every security rule has a comment above it** saying what it allows and
  what it protects against (James's standing rule).
- `packages/db/src/supabase-types.ts` is edited by hand (no local stack to
  generate it).
- Hebrew UI, right-to-left, usable at phone width; the matrix has a separate
  phone layout (`arrangement-matrix-mobile.tsx`) that gets the same feature.
- Line endings: most of the tree is CRLF (29 of 120 web source files are LF).
  Edit keeps a file's endings; new files follow their folder's neighbours.

## 6. Approaches considered (James chose the first of each, 2026-11-15)

| Part | Chosen | Rejected, and why |
|---|---|---|
| Reminder to chosen people (3, 5) | One queued message carrying an optional list of people; the recipient function sends to exactly those | One queued message per person: the WhatsApp log fills with copies, and the recipient function changes anyway |
| Email change (4) | Inside the row edit on משתמשים, as in Bubble: one שמור, email first | A separate "שנה אימייל" button: cleaner underneath, but unlike Bubble and the rest of the screen |
| Stock edit (6) | A popup that saves at once through `save_pick_lines` | Folding stock into "שמור שינויים": rewrites the just-finished grid save (0103) for little gain |
| Pickup time (7) | The grower's choice goes into the pick's existing `daily_picks.pickup_time` | A new column: every screen and the transporter message would need changing to read it |
| Filter and counter (1, 2) | Worked out in the browser from what each screen already loads | — no other sensible way |

For a customer with a WhatsApp group (none of 46 has one today), James chose
Bubble's way on 2026-11-15: the reminder window still lists people, and the
reminder never goes to the group.

## 7. The design, part by part

### 7.1 Status filter and counter (1, 2) — web only

**Today.** Both screens (`routes/backoffice/distributor-grower.tsx`,
`distributor-customer.tsx`) list every active company, sorted by name, with a
search box. Each row is an `ExpandableEntityRow`. The day's picks / orders are
already loaded with their `status`.

**Filter.** A select next to the search box, labelled "סינון לפי סטטוס":

| Screen | Choices | Meaning |
|---|---|---|
| בשם מגדל | הכול · טיוטה · נשלח · סגור · ללא ליקוט | the grower's pick status that day (`draft` / `submitted` / `closed`), or no pick at all |
| בשם לקוח | הכול · פתוחה · נשלחה · ללא הזמנה | the order's status (`open` / `submitted`), or no order row at all |

- Applied together with the search box.
- When the filter leaves nothing, the empty state says "אין מגדלים/לקוחות
  בסטטוס הזה" with a hint to choose another status.
- Bubble's order statuses beyond "נשלחה למשווק" were never used (the PRD's
  known gap G5 calls them placeholders), so they are not offered.

**Counter**, using Bubble's wording, beside the filter:

- בשם מגדל: "הזינו קטיף: X מתוך Y" — Y = growers on the list who have a pick
  that day; X = those whose pick is `submitted` or `closed`.
- בשם לקוח: "הזמנות הוזנו: X מתוך Y" — Y = customers on the list who have an
  order that day; X = those whose order is `submitted`.
- It counts the whole day: the search box and the filter do not change it.
- Hidden when there is nothing to count: no trading day, the shop not open yet
  (בשם לקוח's empty state), or Y = 0.

The status of each row and both counts come from one small pure function per
screen, unit-tested.

### 7.2 Reminder to chosen people (3), and the bell on סידור (5)

**Today.** The bell calls `send_order_reminder(p_daily_order_id)` (0028,
`security invoker`). It stamps `daily_orders.reminder_sent_at` and queues one
`notification_outbox` row (`recipient_company_id` = the customer,
`template_key` = `order_reminder`). The sender asks
`resolve_outbox_dispatch` (0102) for targets: the company's WhatsApp group if
it has one, otherwise every user of the company whose phone
`whatsapp_personal_number()` can read. A customer with no such user is
"sent" a reminder that reaches nobody (15 of 46 active customers have no user
at all).

**The window.** Pressing the bell opens a dialog instead of sending:

```
 שליחת תזכורת — <customer>
 מקבלי ההודעה:
  ☑ דנה לוי          050-•••4512
  ☑ משה כהן          052-•••9031
  ☐ רוני אבן         אין טלפון
            [ביטול]  [שלח]
```

- It lists every profile whose `company_id` is the customer (the same people
  the sender considers today), sorted by name. The list is read each time the
  window opens: profiles send no live updates (0061), and someone added a
  minute ago must appear.
- A person can be ticked only if `toWhatsAppPersonalNumber(phone_number)`
  (`@ori/shared/phone`) is not null — the same rule as the database's
  `whatsapp_personal_number()`, both tested against `phone-cases.json`.
  Everyone who can be ticked starts ticked. The others show why: "אין טלפון"
  or "מספר לא תקין".
- The number shows its last four digits only.
- "שלח" is off while nobody is ticked. With nobody able to receive it, the
  window says so in a sentence.
- Sending: the same optimistic `reminder_sent_at` patch, toast and
  `nudgeWhatsAppDispatch` as today, then the dialog closes.
- The bell is enabled exactly when it is today: a live day, the customer has
  an order, it is not submitted, no reminder is being sent.

**On סידור (5).** Each customer card on the arrangement board
(`customer-demand-board.tsx`) gets the same bell beside its pencil, opening
the same window, with the same enabled rule. `CustomerDemand` gains the
order's id, which the board's read already has (`BoardOrder.id`).

**Database — migration `0104_order-reminder-recipients.sql`:**

1. `notification_outbox.recipient_user_ids uuid[]`, nullable, with a column
   comment. NULL means "the company's usual routing", which is every row
   that exists today and every row any other function writes.
2. `send_order_reminder` is dropped and re-created as
   `send_order_reminder(p_daily_order_id uuid, p_recipient_user_ids uuid[] default null)`:
   - NULL list: exactly today's behaviour (old browser tabs, the seed scripts).
   - A list: duplicates removed; refused when empty (`P0008`) or when any id
     is not a profile of this order's customer (`P0008`, saying so), so a
     person moved to another company in the meantime is refused, not messaged.
     It is stored on the queued row.
   - The role check becomes fail-closed (`is distinct from 'backoffice'`, the
     0076 pattern); today's `<>` lets a caller with no role past it (the
     table's row-level security still stopped the write).
   - Still `security invoker`: the office's own row-level security covers both
     writes, as today.
   - Permissions restated, each with its comment: revoked from `public, anon`;
     granted to `authenticated, service_role`.
3. `resolve_outbox_dispatch` is re-created from 0102's body with one branch
   added first: when `recipient_user_ids` is not null, it returns one
   personal target per listed user who still belongs to the row's company and
   has a readable number, addressed by first name, in the same user order as
   today's branch, and never the group.
   Otherwise the body is 0102's, unchanged. Same signature, so its grants and
   the sender stay as they are.
4. `resolve_outbox_preview` (dev-only preview) is not changed.

The delivery log (`notification_deliveries`, 0078) keeps naming the customer
company per message, which stays right.

**Domain.** `sendOrderReminderInputSchema` gains an optional
`recipientUserIds` (unique uuids, 1 to 50); `toSendOrderReminderRpcArgs`
passes `p_recipient_user_ids` only when it is given.

### 7.3 Change a user's email (4)

**Today.** The email column on משתמשים is read-only. Emails come from the API
(`trpc.auth.listUserEmails`, service role), because `auth.users` is not
reachable from the browser.

**The change.** While a row is being edited, its email cell is a text box
like the others. Changing only the email counts as a change (שמור turns on).
The office may change its own email too; its session carries on. Saving the
row:

1. Checks everything first, as today (the phone, the other fields), and also
   that the email looks like an email. Nothing has been written yet.
2. If the email changed (compared after trimming and lower-casing), calls the
   new API procedure `auth.updateUserEmail({ targetUserId, email })`.
   A refusal (the address belongs to someone else, or the user is gone) stops
   here: nothing else is saved, the row stays in edit mode, and the message
   says why.
3. Then the existing writes (`save_user`, then the phone).
4. If step 3 fails after step 2 succeeded, the message says the email was
   changed and the other changes were not, and the screen re-reads (the same
   recovery the two existing writes already have).
5. On success, `listUserEmails` is re-read along with the rest.

**Server.** `apps/api/src/routers/auth.ts` gets `updateUserEmail`, a
`backofficeProcedure` (the existing office-only guard; the comment above it
says what it allows and protects against). It calls a new domain function
`packages/domain/src/auth/update-user-email.ts`, which normalises the address
(`normalizeEmail`) and calls the Supabase Admin API
`updateUserById(targetUserId, { email, email_confirm: true })`:

- `email_confirm: true` applies it at once, with no confirmation email.
- The person stays signed in; their password is unchanged; next time they
  sign in with the new address.
- Supabase refuses an address another account uses; that becomes a new
  `EmailInUseError`, which `trpc-errors.ts` turns into a CONFLICT with a Hebrew
  sentence. A missing user is the existing `UserNotFoundError`.

**Why this adds no new power:** the office can already change any user's phone
and then send them a password-reset link, so changing an email does not let
the office into an account it could not already reach.

**The Bubble importer** matches logins by email, but a run replaces every
login, and it is locked once the cutover is done (0084), so an email changed
in Ori cannot create a duplicate there.

### 7.4 Quick stock edit (6)

**Today.** The grower's lines (today's pallets `pallets_picked`, previous
stock `leftover_pallets`, a comment) are edited through the grower's pick
editor (`PickLinesEditor`), which calls `save_pick_lines(p_daily_pick_id,
p_lines)` (0076). That function: lets the office or that pick's grower in;
refuses a closed pick; refuses a line whose picked + leftover would drop below
what is already arranged from it (`P0006`); updates only the lines it is
given; sends the office alert only when the grower is the one saving.

**The popup.** One shared component, used in three places:

```
 עדכון מלאי — <grower> · <variety>
   משטחים מהיום: [ 12 ]
   מלאי קודם:     [  3 ]
   כבר סודרו: 9
            [ביטול]  [אישור]
```

- On open it reads that one line fresh (pallets, leftover, comment, the pick's
  status, and the sum of the line's saved arrangement records — "כבר סודרו"),
  so the save sends back the line's current comment rather than a stale one,
  and all three places show the same floor.
- The boxes take numbers exactly as `PickLinesEditor`'s pallet boxes do, and
  the save is checked by `pickLineInputSchema`. "אישור" is off when the total
  would be below "כבר סודרו"; the server's `P0006` stays the real guard and
  its message is shown if it fires.
- Unsaved grid numbers are not part of that floor (only saved records are).
  If a lower stock no longer covers them, the row's "זמין" turns red and
  "שמור שינויים" refuses that cell — what already happens today when a grower
  lowers stock while the grid holds unsaved numbers.
- "אישור" calls `save_pick_lines` with that one line, then re-reads the screens
  that show stock (the arrangement day, מוצרים שנקטפו, בשם מגדל).
- Offered only on the live open day, while the pick is not closed (truck) and
  the grid is not held (saving or "הצע סידור" running).

**Where it opens:**

- **סידור לפי מוצרים:** the "סה״כ במלאי" number becomes a button on each grower
  row, and on a product row that only one grower supplies (that row already is
  that grower's line — `expandable === false`). On a product with several
  growers the sum stays plain. Same in the phone layout.
- **מוצרים שנקטפו:** the "משטחים במלאי" number becomes a button when exactly one
  grower supplies that product that day. Its read
  (`pickedProductsQueries.varietiesForDay`) also returns, per product, the
  line (id, pick id, grower name) when there is exactly one.

**The grid's unsaved changes are safe:** they are kept per day as lines, above
the screen (`unsaved-changes.tsx`), and re-laid onto every read, so the
re-read after a stock save keeps them.

No database change.

### 7.5 Pickup time (7)

**Today.** The office sets each grower's default (`companies.default_pickup_time`,
on מגדלים). A pick's own `daily_picks.pickup_time` is empty while it is a
draft; `submit_pick` (0076) fills it with the default when the pick is sent;
the day's close fills any still empty (`coalesce`). Every screen shows
`pick.pickup_time ?? default` (`formatPickupTime`, `effectivePickupTime`), and
the transporter's end-of-day message uses
`coalesce(dp.pickup_time, gc.default_pickup_time)` (0081).

**The change (Bubble's behaviour):** on the grower's picking screen
(`routes/grower/picks.tsx`, `PickDetail`), "שעת איסוף 14:00" becomes a button
with a pencil. It opens a small dialog with a time box (hours and minutes)
showing the current time; "שמור" saves it for that pick only.

- Allowed while the pick is not closed, including after it was sent (as in
  Bubble). A past day's pick is always closed, so history shows the time
  without the button.
- With no default and nothing chosen, the strip says "שעת איסוף: לא נקבעה"
  with the same button. A closed pick with no time shows nothing, as today.
- No alert to the office (Bubble sends none). The office sees the new time
  wherever it already shows a pick's time: the board (whose growers column is
  ordered by it), בשם מגדל, and the transporter's message. `daily_picks` sends
  live updates (0060), so open office screens refresh by themselves.

**Database — migration `0105_grower-sets-pickup-time.sql`:**

1. New `set_pick_pickup_time(p_daily_pick_id uuid, p_pickup_time time)
   returns daily_picks`, `security definer` (growers can only read
   `daily_picks`; every write to it goes through a checked function),
   `set search_path = public`:
   - lets in the office, or a grower of the company the pick belongs to — the
     fail-closed check from 0076, with its comment;
   - refuses a missing pick (`P0002`), a closed pick or a closed day (`P0007`),
     an empty time (`P0008`);
   - sets `pickup_time` and `updated_at`.
   - Revoked from `public, anon`; granted to `authenticated, service_role`.
2. `submit_pick` re-created from 0076 with one change: it keeps a time already
   on the pick (`coalesce(pickup_time, default)`). It only ever runs on a
   draft, and a draft has a time only if the grower chose one, so a grower who
   never chose keeps exactly today's behaviour.
3. Not changed: `revert_pick_to_draft` (no screen calls it since 0062) still
   empties the time; the day's close already keeps a time that is set.

**Domain.** `setPickPickupTimeInputSchema` (`dailyPickId`, `pickupTime` as
"HH:MM") and its RPC-args mapper.

## 8. Rollout

1. James runs `0104` and `0105` on live, in either order, before the new
   website goes live. Today's website keeps working after them (section 5).
2. Push to main; Vercel deploys the website and the API together.
3. No redeploy of `whatsapp-dispatch`.

## 9. How nothing gets broken

Before anything is pushed or migrated:

1. **Separate branch** in its own worktree; `main` is untouched until James
   says so.
2. **Unit tests** for every new pure function (row status and counts,
   recipient defaults and masking, stock-popup limits, time formatting), and
   the existing web, domain, API and shared suites stay green; typecheck,
   lint and build pass.
3. **Database tests** (`packages/domain`) for both migrations — every allowed
   and refused case, permissions included — run locally against the PGlite
   harness (`vitest-local.mjs`, session c512e411's copy) as well as in CI.
4. **Migration replay** on PGlite: all migrations, then 0104 and 0105; a
   before/after catalog diff shows only the intended changes; **every existing
   outbox row resolves to the same targets before and after** (all eleven
   templates, groups and no groups); a whole trading day runs through.
5. **End-to-end:** the existing reminder test in `distributor-customer.spec.ts`
   is updated (its customer gets a user with a phone, and it goes through the
   window); a new test per feature; the whole e2e suite runs on the local
   harness (`e2e-local.mjs`, real API, zero production contact), and the
   194-step click-through compares main with the branch: only the intended
   differences may appear.
6. Nothing is pushed and nothing is migrated without James.

## 10. Found while designing (not built here)

Bubble's routing differs from Ori's per message (read 2026-11-15). Ori sends
every queued message to the company's group if it has one, otherwise to each
user with a phone. Bubble does not:

| # | Message | Bubble | Ori |
|---|---|---|---|
| 2 | Pick reminder | the group and each person privately | the group only |
| 4 | Shop opened | each person, never a group | group if set (no customer has one) |
| 6 | New order | office staff, plus a copy to the person who ordered | office staff only |
| 12 | Reset link | one office person ("assigned distributor") | the user's own phone |

Messages 3, 7, 8 and 9 also have group and personal sends in Bubble whose
exact rules have not been read yet. To be listed in full for James to decide
separately.

## 11. Left to the builder

File and component names; styling within the existing components; the time
box's minute step; test names; the exact Hebrew of error sentences not quoted
here; how the matrix shows the button's focus. Anything else that changes what
a user sees or who gets a message goes back to James.
