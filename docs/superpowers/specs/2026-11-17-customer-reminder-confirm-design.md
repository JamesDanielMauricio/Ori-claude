# בשם לקוח reminder: a yes/no question, not a list of people — design

**Date:** 2026-11-17 · **Status:** approved by James (2026-11-17, "yes") · **Size:** small change, website only
**Branch:** `fix/customer-reminder-confirm`, from local `main` 0141839 (the WhatsApp routing work, not pushed yet)

## 1. Why

James (2026-11-17): the WhatsApp alerts should work exactly as they do in Bubble — "we don't need to show
a popup and choose who to send the alert."

Read from Bubble's live app the same day (read-only):

| Bell | Bubble | Ori before this change |
|---|---|---|
| סידור board, customer card (`Arrangement view (new)`, popup `bTWgf1`) | yes/no question, then sends; no list | yes/no question on local main (routing work); the choose-people window on the live site |
| בשם לקוח (`Distributor (customer's view)`, popup `bTOCN0`) | yes/no question **plus a ticked list of the customer's users** (list `bTVOJ0`, all ticked at first; the send `bTPFj0` runs on the ticked users) | the choose-people window (0104, e19d036) |
| בשם מגדל (`Distributor (grower's view) v2`, popup `bTXzz0`) | yes/no question, then sends | sends at once |

Bubble itself shows a list on בשם לקוח, so James was asked which he wants there. He chose to remove it:
the bell on בשם לקוח asks yes/no and sends the way the board does.

This replaces his 2026-11-15 rule for a customer with a WhatsApp group ("list the people, never the
group"): the group now gets the reminder. On live, one active customer (א.צ) has a group.

## 2. Goals

1. On בשם לקוח the bell opens the same box as the סידור board: title `שליחת תזכורת`, text
   `לשלוח ל<customer> תזכורת לשלוח הזמנה?`, buttons `ביטול` / `שלח`.
2. `שלח` sends the reminder with no list of people, so the server's rule decides: the customer's
   WhatsApp group, otherwise each person with a usable phone (`resolve_outbox_dispatch` — 0104 on live,
   0107 after the routing work).
3. The box closes at once; the row's bell shows the send in progress; the result is a toast
   (`התזכורת נשלחה.` or `שליחת התזכורת נכשלה: …`). The optimistic `reminder_sent_at` patch on
   בשם לקוח stays as it is.

## 3. Non-goals

- The grower bell on בשם מגדל (Bubble asks first, Ori sends at once) — left as it is (James, 2026-11-17).
- Any database change. `send_order_reminder` keeps accepting an optional list (nothing in the app sends
  one after this; an old open tab still can), and its P0008 refusal text in `error-message.ts` stays with it.
- Message texts, the routing rules, the WhatsApp switches.

## 4. Anti-goals — failures even if it "works"

- A reminder from בשם לקוח that carries a list of people.
- `ביטול` sending anything, or one press sending twice (the bell stays off while a send is in flight).
- Any change to how the board's bell behaves.

## 5. Approaches

- **A — one shared yes/no box, used by the board and by בשם לקוח (chosen).** The wording lives in one
  place; the board's inline dialog moves into it.
- **B — copy the board's box into בשם לקוח.** Two copies of the same wording to keep in step.
- **C — keep the window and hide its list.** Leaves the list code and the window's own error line behind
  with nothing using them.

James approved A (2026-11-17).

## 6. The design

- **The box.** One component (replacing `apps/web/src/components/reference-data/order-reminder-dialog.tsx`)
  takes the target (`{ dailyOrderId, customerName }` or null), `onClose` and `onConfirm`, and renders the
  title, the question and the two buttons with the app's `Dialog` and `Button`. It is used by
  `routes/backoffice/arrangement.tsx` (whose inline dialog goes) and
  `routes/backoffice/distributor-customer.tsx` (whose list window goes).
- **בשם לקוח.** The bell sets the target; `שלח` calls `reminderMutation.mutate({ dailyOrderId })` and
  closes the box; the bell's existing `reminding` / `remindDisabled` rules are unchanged.
- **Removed, because only the list window used them:** `oversightQueries.customerPeople`;
  `apps/web/src/lib/order-reminder.ts` and its test (`reminderPeople`, `initiallyTicked`,
  `shouldResetOnClose`, `failureNeedsToast`); the hook's `openWindow` / `closeWindow` and its
  `windowOpen` bookkeeping (a failure is always a toast now); the hook's `recipientUserIds` input; the
  list window's test.
- **Kept:** the domain's `sendOrderReminderInputSchema` with its optional `recipientUserIds` and its
  tests — it describes the database function, which still accepts a list.
- **Tests.**
  - A unit test for the shared box: title, question with the customer's name, the two buttons, no
    checkboxes.
  - `apps/web/e2e/distributor-customer.spec.ts`: the reminder tests become — the bell asks (no
    checkboxes); `ביטול` sends nothing; `שלח` sends one request without `p_recipient_user_ids`, the
    outbox row has `recipient_user_ids` null, and `reminder_sent_at` is stamped; a send held in flight
    keeps the bell off and a later refusal shows as a toast. The "untick everyone" and "person moved to
    another company" tests are removed (there is no list).
  - The board's reminder tests in `arrangement.spec.ts` pass unchanged.

## 7. Rollout

Website only. It works on today's live database (0106) and after 0107, because a send with no list is
what the board already sends. It is built on the routing work, so it ships with it: James runs 0107, then
one PR to `main` (direct pushes are blocked). Note: the pushed `dev/seed-script` branch also contains the
routing commits, so merging that PR first would put the routing website changes live on their own — safe
in either order (routing design §9).

## 8. Left to the builder

- The shared box's component name and file name.
- How its unit test renders it (the old test used `renderToStaticMarkup`).
