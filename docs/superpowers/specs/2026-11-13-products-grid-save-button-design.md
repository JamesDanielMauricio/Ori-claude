# Products grid: one save button instead of auto-save — design

**Date:** 2026-11-13 · **Status:** for James's review · **Screen:** סידור לפי מוצרים (`/backoffice/new-arrangement`)

## 1. Goal

Today every cell of the products grid saves the moment it is left (Enter, Tab, an
arrow key or a click elsewhere), on the desktop grid and on the phone list alike.
James: the inputs feel like auto-binding; the office wants an explicit save
button that saves all the changes — "as simple as that".

Done means:

- typing in any cell writes nothing to the database;
- one button, **שמור שינויים**, saves every unsaved change in one go — all of
  them or none;
- unsaved changes are still there after switching to another screen of the app
  and back; a reload clears them (James, 2026-11-13: losing them on reload is fine).

## 2. Scope

### In scope

- The products grid, desktop (`arrangement-matrix.tsx`, `matrix/*`) and phone
  (`arrangement-matrix-mobile.tsx`), and its route (`routes/backoffice/new-arrangement.tsx`).
- "הצע סידור": its suggestions become unsaved changes saved by the same button.
- One new database function, migration **0103** `save_arrangement_changes`.
- Domain schema, tests, the arrangement e2e spec.

### Out of scope (non-goals)

- **סידור לפי מגדל** (the board) keeps saving each ✓ at once.
- Keeping unsaved changes across a reload, a closed tab or another device.
- A "you have unsaved changes" warning: switching screens keeps them, and a
  reload may drop them.
- Pricing, closing the arrangement, WhatsApp. Unchanged: saving a cell never
  messages anyone (arrange_to_customer and delete_arrangement_record queue
  nothing; messages go out from close_arrangement).

### Anti-goals (a failure even if it works)

- A save that leaves the day half-saved.
- A save that silently overwrites a number another distributor saved meanwhile.
- One account's unsaved numbers shown to, or saved by, another account on a
  shared computer.
- An unsaved number that looks like a saved one.

## 3. Approaches considered

| # | Approach | Trade-off | Decision |
|---|---|---|---|
| 1 | Save button loops in the browser: one arrange_to_customer / delete_arrangement_record call per changed cell | No migration. A refusal half-way leaves the day half-saved; overwrites a cell someone changed meanwhile. 0075 replaced exactly this loop for the proposal, for those two reasons. | Rejected |
| 2 | One database call that applies every change in one transaction, all or nothing, refusing cells that changed underneath | Needs migration 0103, run by James before the app ships. | **Chosen** (James, 2026-11-13 — confirm when approving this doc) |
| — | Reuse save_arrangement_proposal (0075/0085) | Cannot: it only fills empty cells, so it cannot change or clear one. | Not possible |

## 4. What the distributor sees

### 4.1 Typing

- Enter, Tab, the arrow keys and clicking away still move between cells and
  accept the number typed — but accepting it makes it an **unsaved change**, not
  a write. Escape still cancels the box being typed in.
- A cell with an unsaved change is drawn in the existing unsaved look
  (`UNSAVED_BOX`, dashed green border) on both layouts — also a read-only
  product sum that contains one. Its title (hover text) becomes **עדיין לא נשמר**.
- Emptying a saved cell is an unsaved removal; the empty box keeps the unsaved look.
- Typing a cell back to its saved number removes its unsaved change.
- The totals (זמין, סה״כ חולק, product sums) count unsaved numbers, the way they
  already count proposal numbers (buildMatrix adds the proposal on top).
- A number typed into an empty cell is "for the customer's order" when, on the
  day as read at that moment, the customer has ordered that product — the rule
  typeIntoProposal uses today. Otherwise it is a push.

### 4.2 The unsaved-changes bar

Today's proposal banner becomes the bar for all unsaved changes:

- Shown while there is at least one unsaved change.
- Says **N שינויים שלא נשמרו** (one: **שינוי אחד שלא נשמר**). When suggestions
  from הצע סידור are among them, it adds today's proposal lines (pallets in how
  many cells; rows left out; rows held to the order).
- Buttons: **שמור שינויים** and **בטל שינויים**. Discarding asks first
  (**לבטל את כל השינויים שלא נשמרו?**), using the app's existing dialog.
- While a save runs: both buttons disabled, the save button says **שומר…**, and
  the grid is read-only — as the proposal save holds it today.
- The legend line "מספר בתא כזה = …" is shown whenever the bar is, reading
  **מספר בתא כזה = עדיין לא נשמר**. The desktop keyboard hint adds that changes
  are saved only with שמור שינויים.

### 4.3 Pressing save

One call to save_arrangement_changes with every unsaved change. Three outcomes:

1. **Saved.** Re-read the day and wait for it, then clear the changes that were
   sent (so saved cells never flash empty between the two). Toast:
   **הסידור נשמר: N תאים.**
2. **Refused** — more pallets than picked or ordered (P0009), a closed pick
   (P0010), the arrangement closed (P0007), bad input (P0008), a row gone
   (P0002): nothing is saved. The bar shows the reason naming the cell
   ("product (grower) ← customer", via the existing cellLabel /
   saveRefusalMessage), with a toast. Every unsaved number stays, to be fixed
   and saved again.
3. **Conflict (P0006)** — a cell changed by someone else since it was changed
   here, or the order a cell was meant for was withdrawn: nothing is saved.
   Those cells' unsaved numbers are dropped (the cell now shows what is saved),
   and the bar names them and says the rest can be saved again. This is the
   "mends itself" rule the proposal save already has.

After any failure, including a dropped connection, the day is re-read; a change
whose cell already holds its number counts as saved and is dropped. That keeps a
retry after a lost answer from being refused as a conflict with itself.

### 4.4 Where unsaved changes live

- **Kept** when switching to any other screen of the app and back, when the
  browser tab is in the background, and when the window crosses between the
  desktop grid and the phone list.
- **Gone** after a reload or closing the tab (memory only — no localStorage).
- **Gone** on sign-out or when another account signs in: they belong to the person
  who typed them. Follow the per-account scope (lib/providers.tsx,
  lib/account-scope.ts), which already empties the cache and remounts every
  screen when the account changes.
- **Per trading day.** Each day keeps its own; switching the sidebar date shows
  that day's. A day whose arrangement closes, or which can no longer be edited,
  loses its unsaved changes.
- A re-read of the day (live updates, refresh-on-return, another distributor's
  save) never removes a typed change. Typed numbers are never changed or dropped
  by a re-read; a conflict surfaces at save time (4.3).

### 4.5 הצע סידור

- Offered only when there are no unsaved changes. The engine plans against what
  is saved, and with unsaved numbers around it could plan the same pallets twice.
- Its suggestions are added as unsaved changes and saved by the same button;
  **שמור לסידור** and **בטל הצעה** go away.
- Suggestions keep today's rules on every re-read (resolveProposal): held to
  the customer's order, cut to what is left of it, dropped when their cell is
  filled meanwhile. Numbers typed afterwards are ordinary unsaved changes (4.1).

## 5. Database — migration 0103 `save_arrangement_changes`

```
save_arrangement_changes(p_trading_day_id uuid, p_changes jsonb) returns integer  -- cells written
```

Each change:

```
{ "dailyPickProductId": uuid,
  "customerCompanyId": uuid,
  "quantityPallets": number >= 0, at most one decimal (0 = clear the cell),
  "expected": { "recordId": uuid | null, "quantityPallets": number >= 0 },  -- what the cell held when it was changed; null/0 = empty
  "forOrder": boolean (optional) }
```

Rules, modelled on 0075/0085 (same checks and DETAIL shapes, so the screen's
refusedCells reads both):

1. Backoffice only (`current_role()`), else 42501.
2. The day's arrangement exists (P0002) and is open (P0007).
3. Locks in 0075's order (R7): trading_days FOR SHARE → daily_arrangements FOR
   UPDATE → the pick lines touched FOR SHARE in id order → the order headers of
   the customers involved FOR UPDATE in id order.
4. Well formed (P0008, DETAIL `indexes`); a cell at most once (P0008, DETAIL
   `cells`); every pick line on this day (P0002, DETAIL `pickLineIds`).
5. Every cell still holds `expected` — the same record id and quantity, or still
   empty — else P0006 naming **every** such cell (DETAIL `cells`).
6. A `forOrder` cell whose order has gone: P0006 naming every such cell (as 0075).
7. Apply inside one exception block: **clears and decreases first, then
   increases and new cells**, so moving pallets between two customers on one
   lot is not refused for the moment both hold them. Each change goes through
   the existing functions, so their rules stay in one place:
   delete_arrangement_record for a clear, arrange_to_customer for a number
   (price arguments null, so it COALESCEs and the record keeps its own price).
   check_arrangement_allocation, the closed-pick trigger (0089), the tenths
   trigger (0085) and the zero-pallet order line for a push all apply unchanged.
8. Any failure re-raises with the original SQLSTATE and message, DETAIL naming
   the cell (`index`, `dailyPickProductId`, `customerCompanyId`,
   `quantityPallets`). Nothing is saved.
9. Read the JSON into typed arrays once and join only on those, never on values
   pulled out of the JSON inside a join — 0075's note: under RLS that read
   82,000 pick lines per cell and passed the 8-second statement timeout.
10. **Security** (each rule with a comment saying what it allows and what it
    protects against): SECURITY INVOKER, so it writes through the caller's own
    RLS; EXECUTE revoked from public and anon, granted to authenticated and
    service_role.
11. Added to `meta/_journal.json` (otherwise CI never runs it). The header says it
    is unapplied until James confirms.

save_arrangement_proposal stays, so a tab still open on the old app during the
release keeps working. Nothing new calls it.

## 6. Domain — `packages/domain/src/arrangement/schemas.ts`

`saveArrangementChangesInputSchema` and `toSaveArrangementChangesRpcArgs`, beside
the proposal's: quantity 0 or an arranged quantity (positive, at most one
decimal); `expected` as in §5; a cell at most once (the same refine the proposal
schema has). Exported from `index.ts`. ARRANGEMENT_ERROR_CODES' notes name the
new function where P0006 and P0002 now come from it too.

## 7. Web

- **The store.** Unsaved changes live outside the screen, inside the per-account
  scope, in memory only (§4.4). Where exactly is the builder's call (for example
  a context mounted with the backoffice layout, or the per-account query client).
- **Shape (recommended).** One list of lines in the proposal's own terms —
  grower × product × customer, not row ids, because pick lines are pruned and
  re-created by the season sync and other jobs — extending `ProposalLine` with
  `expected` and allowing 0 for "clear". resolveProposal, or a sibling, lands
  them on the day as read, and buildMatrix's `proposal` input grows from "add on
  top of an empty cell" to "set this cell to N". The builder may pick a simpler
  shape if the plan shows one.
- **The grid.** useMatrixCursor's commitDraft and the phone list's commit record
  a change instead of writing one. This screen's commitCell and its
  arrangeMutation / deleteMutation go away (the board keeps its own).
- **The save.** One mutation with its own mutation key, so "is a save running"
  is asked of the mutation cache from any mount (as SAVE_PROPOSAL_KEY does
  today). Results as §4.3; describeRpcError names migration 0103 for PGRST202.

## 8. Testing

- **Database** (`packages/domain/src/arrangement/arrangement.test.ts`): a mix of
  new, changed and cleared cells in one call; a refusal half-way saves nothing; a
  conflict when a cell was filled, changed or emptied since `expected`, naming
  every cell; `forOrder` with the order withdrawn; moving pallets between two
  customers on a fully used lot (decrease first); a closed pick; a closed
  arrangement; a non-backoffice caller; malformed and repeated cells; tenths.
- **Schema** tests beside the proposal's.
- **Web unit tests:** the matrix overlay (set, clear, back to saved); the store
  (survives the screen unmounting, emptied on account change, per day);
  suggestions and typed numbers across a re-read as §4.4–4.5.
- **e2e** (`apps/web/e2e/arrangement.spec.ts`, the grid section): 5 + Enter shows
  unsaved and the board has nothing yet; save, and the board shows 5; 99 + save
  is refused naming the cell, saves nothing and keeps 99 unsaved; discard
  returns to 5; an unsaved number survives going to the board and back; a
  reload clears it.
- **Before pushing:** the whole e2e suite and the domain tests run locally against
  the harness (e2e-local.mjs, vitest-local.mjs), since CI cannot be read from here.

## 9. Release

1. James runs 0103 on production and confirms. Until then it is unapplied.
2. Then the app is pushed. If it went first, the save button would only say the
   migration has not been run.

No edge-function redeploy: whatsapp-dispatch reads nothing 0103 touches.

## 10. Calls made while writing this (check these)

1. Discard asks before throwing changes away.
2. הצע סידור is offered only when nothing is unsaved.
3. After a conflict, the conflicting cells' unsaved numbers are dropped and
   named; the rest stay to be saved again.
4. Unsaved changes are kept per trading day, and dropped when that day's
   arrangement closes.
5. The wording of the bar, the hover text, the legend and the hint.
6. save_arrangement_proposal is kept but no longer called.
