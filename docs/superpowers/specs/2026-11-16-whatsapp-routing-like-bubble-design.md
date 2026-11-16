# WhatsApp routing like Bubble — design

Status: approved by James (2026-11-16). Approach A chosen by James.

## 1. Why

James asked (2026-11-16) for Ori to send each WhatsApp message to the same people Bubble sends it to —
the company's WhatsApp group, its people privately, or both — for every message except the password
reset link. Today Ori has one rule for every message: the group if the company has one, otherwise each
person with a usable phone.

WhatsApp sending is switched off on live (all five switches in הגדרות מערכת are off; every one of the 310
messages queued since 2026-11-09 was skipped), so nobody is affected until the office switches it on.
The routing should be right before that. (Inferred, not stated by James: people who got a message from
Bubble should get the same message, in the same place, from Ori.)

## 2. What Bubble does (read 2026-11-16 from the live app, read-only)

| # | Message | Bubble | Ori today | Change |
|---|---|---|---|---|
| 1 | Day opened, to growers | group, else each person | same | none |
| 2 | Pick reminder (bell on בשם מגדל) | the group **and** each person privately | group, else each person | yes |
| 3 | Grower confirms the pick | posted in **the grower's own group** only | each office person privately | yes |
| 4 | Shop opened, to customers | each person privately, never the group | group, else each person | yes |
| 5 | Order reminder, from בשם לקוח | the chosen people | same (0104) | none |
| 5 | Order reminder, from the סידור board | a confirm popup, then the group, else every person — no choosing | the choose-people window (shipped e19d036) | yes |
| 6 | New order, to the office | office people **plus a private copy to the customer user who ordered** — only when a customer orders | office people, only when a customer orders | yes |
| 7–9 | Day closed, to transporter / grower / customer | group, else each person (8 skips growers set to "should not receive arrangement") | same (0081) | none |
| 10–11 | Stock alerts, to the office | office people | same | none |
| 12 | Password reset link | one office person ("assigned distributor") | the user's own phone | **none — James keeps Ori's** |

Read with care — Bubble's workflows contain sends that never run, which must not be copied:
- 3: the private send's condition can never be true (`"sd" is "disabled"`); only the group send runs.
- 6: the office send by role has a never-true condition; the live office send and the copy both require
  the current user to be a customer (`Role is לקוח`); a fourth send sits after an unconditional
  "Terminate this workflow" and never runs. When the office orders on a customer's behalf, Bubble sends
  nothing.
- 5 (board), 7, 8: a second set of private sends sits after an unconditional "Terminate this workflow".

Sources: backend workflow `close_arrangement` (9), the arrangement view's "complete" button (7, 8) and
"Alert or Notify the Customer" (5 board), the grower product interface's "confirm/save final process" (3),
the customer order interface's "confirm/save final process" (6). 1, 2, 4, 5 (בשם לקוח) and 12 were read
on 2026-11-15 (see 2026-11-15-bubble-feature-gaps-design.md §10).

## 3. Goals

1. Messages 2, 3, 4, 6 and the board's bell (5) reach exactly the people Bubble's live app reaches (§2).
2. Every other message keeps exactly today's recipients — 1, 5 from בשם לקוח, 7–11 and 12.
3. The office's WhatsApp log names the new copy (6) in Hebrew like every other message.

## 4. Non-goals

- Changing any message text (Bubble's, from 0102), except where §8 says a link must follow its new
  audience.
- Switching WhatsApp on (the office's own switch).
- Routing that the office can edit from the app (approach C, not chosen).
- The reset link (12) — stays on the user's own phone.
- Messages 7 and 8's pickup time: Bubble shows the company default; Ori shows the day's time (0081, a
  deliberate fix) — unchanged.
- Any change to Bubble.

## 5. Anti-goals — failures even if it "works"

- A message reaching a group or a person Bubble would not reach: the copy (6) going to anyone but the
  customer user who ordered; message 3 still reaching the office; a chosen-people reminder reaching a group.
- Any other message's recipients changing.
- A grower's group flooded by a grower saving again and again (message 3 now lands in the group).
- Two copies of one message to the same person where Bubble sends one.
- The WhatsApp sender needing a redeploy, or today's website (open tabs) breaking on the new database.

## 6. Constraints

- Migrations are files only; James runs them. The next number is 0106 (0104 and 0105 are applied on live,
  verified 2026-11-16). Each gets a `packages/db/migrations/meta/_journal.json` entry. An applied migration
  is never edited.
- `whatsapp-dispatch` is not redeployed: `resolve_outbox_dispatch(uuid) returns table(target text,
  is_group boolean, message text)` keeps its signature, security and grants. The sender decides which
  switch a message obeys by its type (`supabase/functions/whatsapp-dispatch/handler.ts:113-120`): a type
  it does not know follows the main switch only, so a new type needs no sender change. A message that
  resolves to nobody is settled as sent with no recipients (`handler.ts:367-371`).
- Old browser tabs keep working: `submit_order`, `save_pick_lines`, `update_pick_product_pallets` and
  `send_order_reminder` keep their signatures; today's board (window, list) keeps working on the new
  database.
- Every security rule (grant, revoke, role check, security definer) has a comment above it saying what it
  allows and what it protects against.
- Hebrew UI, right to left, usable at 375 px. Files CRLF. Tests only against the local harness, never the
  hosted project.

## 7. Approaches (James chose A, 2026-11-16)

- **A — one rule list where Ori decides who gets each message (chosen).** `resolve_outbox_dispatch`
  learns a rule per message type. Messages 3 and 6 also change where they are created (3 is addressed to
  the grower; 6 adds the customer's copy). The board's bell changes in the web app. All routing rules sit
  in one readable place.
- **B — decide when each message is created.** Every function that queues a message writes its routing
  onto the row. Same result, but three more large functions are rebuilt (the reminder and both functions
  that queue "shop opened") — more chances to break something.
- **C — a settings screen.** Like A, with the rules in a table the office could edit later. More to build
  and test; only worth it if James expects to change routing himself.

## 8. The design

### 8.1 The rule list (`resolve_outbox_dispatch`, migration 0106)

A message row **with a list of people** (`recipient_user_ids`, 0104) goes to those people only — never the
group — exactly as today. Every other row follows its message type:

| Message type | Rule |
|---|---|
| `pick_reminder` | the group (if the company has one) **and** each person with a usable phone |
| `shop_open` | each person with a usable phone; never the group |
| `pick_updated` | the group only; no group → nobody (settled as sent, §6) |
| every other type | today's rule: the group if set, otherwise each person with a usable phone |

- When both a group and people are targets, the group comes first, then people in today's order
  (`order by p.user_id`). Greetings as today: the company's name for the group, the first name for a person.
- One place lists the rules, each with a comment saying what Bubble does. Whether that place is a `case`
  inside `resolve_outbox_dispatch` or a small helper naming the rule per type is the builder's call.
- `resolve_outbox_preview` (dev mode only, text only — no recipients) is unchanged.

### 8.2 Message 3 — "the grower confirmed the pick" goes to the grower's own group

- Today `save_pick_lines` and `update_pick_product_pallets` (both 0076) queue `pick_updated` for the
  office through `enqueue_backoffice_notification` (0082: at most 5 of one kind about one company per 10
  minutes), only when the grower is the one saving and a quantity changed.
- New: the same moments and the same conditions, but the row is addressed to the pick's grower company
  (`recipient_type 'grower'`), so §8.1 sends it to that grower's group only. The office no longer receives
  it. The same flood cap applies, counted per grower: at most 5 per 10 minutes per grower and trading day.
- The template's link becomes the grower's picks page, `https://ori-claude-web.vercel.app/grower/picks`
  (Bubble's group message links to the grower screen; the office link would mean nothing to the grower).
- Both functions are rebuilt from 0076's bodies, changed only where they queue the message. How the
  per-grower queueing is written (a small helper like `enqueue_backoffice_notification`, revoked from the
  API roles as 0055 did, or inline) is the builder's call.

### 8.3 Message 6 — a private copy to the customer user who ordered

- Today `submit_order` (latest body in 0102) queues `order_submitted` for the office only when a customer
  submits the order themselves (`v_direct_customer_submission`).
- New: in that same case, also queue one row for the customer's company with
  `recipient_user_ids = array[auth.uid()]`, so §8.1 sends it privately to that one person and never to the
  group. When the office submits on a customer's behalf, nothing changes (Bubble sends nothing then).
- Same text as the office message (Bubble sends main alert 6 to both, greeting the reader by first name),
  ending with the customer's order link instead of the office link. My call for the mechanism: a new
  message type `order_submitted_copy` — a template row with 0102's `order_submitted` content, the title
  `העתק ללקוח ששלח הזמנה` and the link `https://ori-claude-web.vercel.app/customer/order` — and
  `compose_outbox_message` builds its order details exactly as for `order_submitted`. The copy row carries
  the same payload as the office row (order id, sender), so both list the same order. The office's
  WhatsApp log labels it (in `apps/web/src/lib/delivery-labels.ts`): `העתק ללקוח ששלח הזמנה`.
- The copy follows the same cap as the office message: a customer saving again and again is not flooded
  either. How (counting copies the same way, or `enqueue_backoffice_notification` reporting whether it
  queued) is the builder's call.

### 8.4 Message 5 on the סידור board — Bubble's way

- Today (e19d036) the board's bell opens the choose-people window, like בשם לקוח.
- New: the board's bell asks for a confirmation, then sends the reminder **without a list**, which §8.1
  routes by today's rule: the group if the customer has one, otherwise each person with a usable phone.
  בשם לקוח keeps its window unchanged.
- The confirmation (my wording; James may change it): title `שליחת תזכורת`, text
  `לשלוח ל<customer name> תזכורת לשלוח הזמנה?`, buttons `שלח` / `ביטול`. Use the app's existing confirm
  pattern.
- Same rule for when the bell is enabled (live day, order not sent, not while a reminder is sending), the
  same success toast `התזכורת נשלחה.`, and a failure shown as a toast `שליחת התזכורת נכשלה: …` (there is
  no window to show it in). The hook already sends without a list (`packages/domain/src/customer/schemas.ts`
  84-102).

### 8.5 Unchanged on purpose

Messages 1, 7, 8 (with its opt-out), 9, 10, 11; the בשם לקוח window; the reset link (12); every text other
than message 3's link; the WhatsApp switches; the WhatsApp sender.

## 9. Rollout

- 0106 and the web deploy can go in either order: today's website keeps working on 0106 (no signature
  changes; an old tab's board still sends with a list, which still goes to the listed people), and the new
  board sends without a list, which today's database already accepts. Recommended: James runs 0106, then
  the push.
- No sender redeploy. Nothing is actually sent until the office switches WhatsApp on.
- The rules apply when a message is sent, so a row queued before 0106 and sent after it follows the new
  rules (an old office `pick_updated` row would reach nobody). On live every row so far was skipped and
  skipped rows are never retried (0048), so none is waiting — accepted, no special case.

## 10. How nothing gets broken (the same proofs as the last batch)

- Catalog diff: only the intended functions and the new template row change.
- Outbox before/after: every message type, for a company with a group and one without, resolved before
  and after 0106. Expected differences, and only these: `pick_reminder` gains the people where a group
  exists; `shop_open` goes to people instead of the group where a group exists; `pick_updated` goes to the
  grower's group instead of the office people; a customer's own submit adds one copy row to that customer.
- Database tests for each rule, the per-grower cap, the copy (customer submits → copy; office submits for
  them → none; cap), plus the existing notification, dispatch, message, grower, customer and lifecycle
  suites.
- Browser tests: the board's bell confirms and sends without a list; the whole suite on the new build;
  today's suite on the new database (old tabs).
- Side-by-side click-through of today's site and the new one; every difference explained.
- After James runs 0106: a read-only check on live that the functions and template match the file.

## 11. Left to the builder

- `case` inside `resolve_outbox_dispatch` versus a small helper naming each type's rule.
- How the per-grower queueing (8.2) and the copy's cap (8.3) are written.
- Which existing confirm component the board uses (8.4).
