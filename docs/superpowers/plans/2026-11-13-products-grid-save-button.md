# Products Grid Save Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On סידור לפי מוצרים, typing records unsaved changes instead of writing them, and one "שמור שינויים" button saves them all in a single all-or-nothing database call.

**Architecture:** A new SECURITY INVOKER function `save_arrangement_changes` (migration 0103) applies every change through the existing `arrange_to_customer` / `delete_arrangement_record` in one transaction, refusing any cell that changed since it was typed over. In the web app an unsaved change is a proposal line (grower × product × customer) that also remembers what the cell held when it was typed over. The lines live in a memory-only provider mounted in the backoffice layout, so they survive switching screens and are thrown away with the account scope. `buildMatrix` overlays them with "set" semantics, and the route's commit callback records a change instead of writing it.

**Tech Stack:** Postgres PL/pgSQL (Supabase), Drizzle journal, zod (`packages/domain`), React 18 + TanStack Query v5 + Vite (`apps/web`), Vitest, Playwright; local verification on the PGlite harness.

**Spec:** `docs/superpowers/specs/2026-11-13-products-grid-save-button-design.md`

## Global Constraints

- Work on branch `feat/grid-save-button`. Never push and never merge into main until James has run 0103 on production and says to push (spec §9).
- Never apply 0103 to a hosted database (production or staging). It runs only inside the local PGlite harness.
- `apps/web/src/lib/xlsx-reader.test.ts` holds James's uncommitted change: never stage it. Stage files by name and run `git status` before every commit.
- Every security rule in SQL carries a comment saying what it allows and what it protects against (James's rule).
- Most existing files use CRLF line endings: change them with the Edit tool, never with Write or `sed -i`.
- Commit messages: conventional prefix (`feat:`, `test:`, `docs:` …) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Hebrew copy, verbatim:
  - bar count: `שינוי אחד שלא נשמר.` / `` `${n} שינויים שלא נשמרו.` ``; proposal sentence `` `הצעת סידור: ${formatPallets(pallets)} משטחים ב-${cells} תאים.` ``
  - buttons: `שמור שינויים` (while saving `שומר…`), `בטל שינויים`
  - discard dialog: title `לבטל את כל השינויים שלא נשמרו?`, body `השינויים שלא נשמרו יימחקו.`, buttons `בטל שינויים` (variant `danger`) and `המשך לערוך` (variant `secondary`)
  - success toast: `` `הסידור נשמר: ${n} תאים.` ``
  - `UNSAVED_TITLE`: `עדיין לא נשמר`; legend: `מספר בתא כזה = עדיין לא נשמר`
  - desktop hint: `הקלד כמות ולחץ Enter או Tab. חיצים לניווט בין תאים. השינויים נשמרים רק בלחיצה על "שמור שינויים".`
  - conflict refusal, with cells: `` `לא נשמר דבר: תאים אלה השתנו בינתיים — שובצו או שונו, או שההזמנה שלהם בוטלה — והמספרים שלך בהם הוסרו: ${cells}. אפשר לשמור שוב.` ``; without: `לא נשמר דבר: חלק מהתאים השתנו בינתיים, והמספרים שלך בהם הוסרו. אפשר לשמור שוב.`
- Local harness (outside the repo), shell variables used below:
  - `H=/c/Users/JAMESD~1/AppData/Local/Temp/claude/94616838bbf90b1a/c512e411-434b-40ed-a110-89560b079dab/scratchpad/harness`
  - `OUT=/c/Users/JAMESD~1/AppData/Local/Temp/claude/94616838bbf90b1a/9cec59b1-4539-4275-aeef-10ef645a6f6c/scratchpad`
  - Ports `SUPABASE_PORT=61321 API_PORT=61399 APP_PORT=4673` everywhere: another session may hold the defaults.
  - Domain test files (schema tests included) run ONLY through `$H/vitest-local.mjs`: the package's own vitest config needs a database.

## Review Focus

1. Another distributor saves a cell you also changed → your save is refused naming it, your number there is dropped and theirs shows, and your other changes save on the next press. → Task 7, e2e step 3.
2. Signing out and back in on the same tab → no unsaved number comes back. → Task 7, e2e step 5.
3. The arrangement is closed while numbers are unsaved → the bar and the unsaved marks disappear, and nothing is saved. → Task 7, scenario s15.
4. A saved cell emptied (an unsaved removal) while "הצג רק מוזמנים" is on → its row and its column stay on screen. → Task 3, test 8.
5. Leaving the grid while a save is still running → the save's result is applied anyway (bar gone, number saved) when you come back. → Task 7, e2e step 4.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `packages/domain/src/arrangement/schemas.ts`, `index.ts` | input schema + RPC args for `save_arrangement_changes` | 1 |
| `packages/db/src/supabase-types.ts` | the function's TypeScript type | 1 |
| `packages/db/migrations/0103_save-arrangement-changes.sql`, `meta/_journal.json` | the function | 2 |
| `packages/domain/src/arrangement/arrangement.test.ts` | its database behaviour | 2 |
| `apps/web/src/components/arrangement/matrix-data.ts` | overlay with "set" semantics, `MatrixCell.unsaved`, `orderedOnly` | 3 |
| `apps/web/src/components/arrangement/matrix/row.tsx`, `arrangement-matrix-mobile.tsx`, `matrix/cell-look.ts` | draw `cell.unsaved` | 3 |
| `apps/web/src/components/arrangement/arrangement-proposal.ts` | unsaved lines: typing over saved cells, re-reads, conflicts | 4 |
| `apps/web/src/components/arrangement/unsaved-changes.tsx` (new) | per-account, per-day, memory-only store | 5 |
| `apps/web/src/routes/backoffice/layout.tsx` | mounts the store | 5 |
| `apps/web/src/routes/backoffice/new-arrangement.tsx` | record instead of write; bar, save, discard, הצע סידור | 6 |
| `apps/web/e2e/arrangement.spec.ts` | the grid section | 7 |

---

### Before Task 1: branch and commit the spec

- [ ] Run:

```bash
cd "d:/Downloads/Downloads/Ori main"
git switch -c feat/grid-save-button
git add docs/superpowers/specs/2026-11-13-products-grid-save-button-design.md docs/superpowers/plans/2026-11-13-products-grid-save-button.md
git status   # only those two staged; xlsx-reader.test.ts stays unstaged
git commit -m "docs: design and plan for the products grid's save button

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Domain schema and database type for `save_arrangement_changes`

**Files:**
- Modify: `packages/domain/src/arrangement/schemas.ts` (new block after `toSaveArrangementProposalRpcArgs`, ~line 141; doc notes on `NOT_FOUND` and `CONFLICT` in `ARRANGEMENT_ERROR_CODES`)
- Modify: `packages/domain/src/arrangement/index.ts` (add the three new names to the explicit export list)
- Modify: `packages/db/src/supabase-types.ts` (Functions, beside `save_arrangement_proposal` ~line 1619)
- Test: `packages/domain/src/arrangement/schemas.test.ts`

**Interfaces:**
- Produces:

```ts
export const saveArrangementChangesInputSchema; // z.object({ tradingDayId: uuid, changes: z.array(change) })
export type SaveArrangementChangesInput = z.infer<typeof saveArrangementChangesInputSchema>;
// change = {
//   dailyPickProductId: string (uuid);
//   customerCompanyId: string (uuid);
//   quantityPallets: number;   // >= 0, at most one decimal (isPalletQuantity), rounded with roundPallets; 0 = clear the cell
//   expected: { recordId: string (uuid) | null; quantityPallets: number /* isPalletQuantity */ };
//   forOrder?: boolean;
// }
// refinements: a cell (dailyPickProductId|customerCompanyId) at most once — same refine as the proposal schema;
//              quantityPallets 0 requires expected.recordId !== null ("clearing an empty cell is no change")
export function toSaveArrangementChangesRpcArgs(input: SaveArrangementChangesInput): {
  p_trading_day_id: string;
  p_changes: SaveArrangementChangesInput["changes"];
};
// supabase-types.ts Functions:
// save_arrangement_changes: { Args: { p_trading_day_id: string; p_changes: Json }; Returns: number };
```

- [ ] **Step 1: Write the failing tests** — new `describe("saveArrangementChangesInputSchema")` in `schemas.test.ts`:

```ts
const DAY = "00000000-0000-4000-8000-000000000001";
const LINE = "00000000-0000-4000-8000-000000000002";
const C1 = "00000000-0000-4000-8000-000000000003";
const C2 = "00000000-0000-4000-8000-000000000004";
const C3 = "00000000-0000-4000-8000-000000000005";
const R2 = "00000000-0000-4000-8000-000000000006";
const R3 = "00000000-0000-4000-8000-000000000007";
const EMPTY = { recordId: null, quantityPallets: 0 };
const change = (over: Record<string, unknown> = {}) => ({
  dailyPickProductId: LINE, customerCompanyId: C1, quantityPallets: 3, expected: EMPTY, ...over,
});
const parse = (changes: unknown[]) => saveArrangementChangesInputSchema.safeParse({ tradingDayId: DAY, changes });

it("accepts a new, a changed and a cleared cell", () => {
  expect(parse([
    change(),
    change({ customerCompanyId: C2, quantityPallets: 5, expected: { recordId: R2, quantityPallets: 2 } }),
    change({ customerCompanyId: C3, quantityPallets: 0, expected: { recordId: R3, quantityPallets: 1 } }),
  ]).success).toBe(true);
});
it("refuses a cell that appears twice", () => {
  expect(parse([change(), change({ quantityPallets: 4 })]).success).toBe(false);
});
it("refuses clearing a cell that held nothing", () => {
  expect(parse([change({ quantityPallets: 0 })]).success).toBe(false);
});
it("takes tenths of a pallet and nothing finer, and no negatives", () => {
  expect(parse([change({ quantityPallets: 0.5 })]).success).toBe(true);
  expect(parse([change({ quantityPallets: 0.55 })]).success).toBe(false);
  expect(parse([change({ quantityPallets: -1 })]).success).toBe(false);
  expect(parse([change({ expected: { recordId: R2, quantityPallets: 0.55 } })]).success).toBe(false);
});
it("maps to the function's argument names", () => {
  const input = saveArrangementChangesInputSchema.parse({ tradingDayId: DAY, changes: [change({ forOrder: true })] });
  expect(toSaveArrangementChangesRpcArgs(input)).toEqual({ p_trading_day_id: DAY, p_changes: input.changes });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
cd "$H" && TEST="d:/Downloads/Downloads/Ori main/packages/domain/src/arrangement/schemas.test.ts" SUPABASE_PORT=61321 node vitest-local.mjs 2>&1 | cut -c1-300 | tail -20
```

Expected: the new cases FAIL (the schema is not exported); the existing cases still pass.

- [ ] **Step 3: Implement** the schema and mapper in `schemas.ts` beside the proposal's (quantity `z.number().refine(isPalletQuantity, PALLET_QUANTITY_MESSAGE).transform(roundPallets)`, the duplicate-cell refine copied from `saveArrangementProposalInputSchema`). Add the `index.ts` exports and the `supabase-types.ts` entry. Extend the `NOT_FOUND` and `CONFLICT` doc comments: "…or from save_arrangement_changes (0103): a cell that changed since it was typed over".

- [ ] **Step 4: Run the tests again and typecheck**

Same command as Step 2 → all PASS. Then `cd "d:/Downloads/Downloads/Ori main" && pnpm --filter @ori/domain typecheck && pnpm --filter @ori/db typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/arrangement/schemas.ts packages/domain/src/arrangement/index.ts packages/domain/src/arrangement/schemas.test.ts packages/db/src/supabase-types.ts
git commit -m "feat(domain): input schema for saving the products grid's changes"   # + Co-Authored-By line
```

---

### Task 2: Migration 0103 `save_arrangement_changes`

**Files:**
- Create: `packages/db/migrations/0103_save-arrangement-changes.sql`
- Modify: `packages/db/migrations/meta/_journal.json`: append `{ "idx": 103, "version": "7", "when": 1793048400000, "tag": "0103_save-arrangement-changes", "breakpoints": true }`
- Test: `packages/domain/src/arrangement/arrangement.test.ts`: helpers next to `saveRaw` (~line 295), cases after the last `save_arrangement_proposal` case (~line 1160)

**Interfaces:**
- Consumes: `toSaveArrangementChangesRpcArgs`, `SaveArrangementChangesInput` (Task 1).
- Produces: `public.save_arrangement_changes(p_trading_day_id uuid, p_changes jsonb) returns integer` (cells written). Errors: `42501` not backoffice; `P0002` unknown day or arrangement, or a pick line not on the day (DETAIL `{"pickLineIds": [...]}`); `P0007` arrangement closed; `P0008` malformed (DETAIL `{"indexes": [...]}`) or repeated cell (DETAIL `{"cells": [...]}`); `P0006` cell changed since typed over, or a `forOrder` cell whose order is gone (DETAIL `{"cells": [{index, dailyPickProductId, customerCompanyId}, ...]}`); anything `arrange_to_customer` / `delete_arrangement_record` / the triggers raise (P0002/P0008/P0009/P0010), with their SQLSTATE and DETAIL `{index, dailyPickProductId, customerCompanyId, quantityPallets}`.

- [ ] **Step 1: Write the helpers and the failing tests**

```ts
// next to saveRaw:
const EMPTY = { recordId: null, quantityPallets: 0 };
function saveChanges(tradingDayId: string, changes: SaveArrangementChangesInput["changes"]) {
  return admin.client.rpc("save_arrangement_changes", toSaveArrangementChangesRpcArgs({ tradingDayId, changes }));
}
function saveChangesRaw(tradingDayId: string, changes: Json) {
  return admin.client.rpc("save_arrangement_changes", { p_trading_day_id: tradingDayId, p_changes: changes });
}
async function arrangeNow(pickProductId: string, customerId: string, quantity: number) {
  const { data, error } = await admin.client.rpc("arrange_to_customer", {
    p_daily_pick_product_id: pickProductId, p_customer_company_id: customerId, p_quantity_pallets: quantity,
  });
  expect(error).toBeNull();
  return data!;
}
const byCustomer = (rows: Awaited<ReturnType<typeof recordsOn>>) =>
  Object.fromEntries(rows.map((row) => [row.customer_company_id, Number(row.quantity_pallets)]));
```

Each case is `it("save_arrangement_changes …", async () => { … }, 30000)`. Customers from `customerWhoOrdersNothing()` are created BEFORE `setUpDayWithSupplyAndDemand` (its comment says why).

```ts
it("save_arrangement_changes saves a new, a changed and a cleared cell in one call, and says how many", async () => {
  const c2 = await customerWhoOrdersNothing();
  const c3 = await customerWhoOrdersNothing();
  const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(10, 3);
  const r2 = await arrangeNow(line, c2.id, 2);
  const r3 = await arrangeNow(line, c3.id, 1);
  const saved = await saveChanges(day.id, [
    { dailyPickProductId: line, customerCompanyId: customer.id, quantityPallets: 3, expected: EMPTY },
    { dailyPickProductId: line, customerCompanyId: c2.id, quantityPallets: 4, expected: { recordId: r2.id, quantityPallets: 2 } },
    { dailyPickProductId: line, customerCompanyId: c3.id, quantityPallets: 0, expected: { recordId: r3.id, quantityPallets: 1 } },
  ]);
  expect(saved.error).toBeNull();
  expect(saved.data).toBe(3);
  expect(byCustomer(await recordsOn(line))).toEqual({ [customer.id]: 3, [c2.id]: 4 });
});

it("save_arrangement_changes saves nothing when one cell is refused, and names that cell", async () => {
  const c2 = await customerWhoOrdersNothing();
  const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 10);
  const saved = await saveChanges(day.id, [
    { dailyPickProductId: line, customerCompanyId: customer.id, quantityPallets: 3, expected: EMPTY },
    { dailyPickProductId: line, customerCompanyId: c2.id, quantityPallets: 4, expected: EMPTY },
  ]);
  expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.OVER_ALLOCATION);
  expect(JSON.parse(saved.error?.details ?? "{}")).toMatchObject({ index: 1, dailyPickProductId: line, customerCompanyId: c2.id });
  expect(await recordsOn(line)).toEqual([]);
});

it("save_arrangement_changes refuses a cell filled since it was typed into, names it, and leaves it as it was", async () => {
  const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 3);
  await arrangeNow(line, customer.id, 1);
  const saved = await saveChanges(day.id, [
    { dailyPickProductId: line, customerCompanyId: customer.id, quantityPallets: 3, expected: EMPTY },
  ]);
  expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
  expect(JSON.parse(saved.error?.details ?? "{}").cells).toEqual([
    { index: 0, dailyPickProductId: line, customerCompanyId: customer.id },
  ]);
  expect(byCustomer(await recordsOn(line))).toEqual({ [customer.id]: 1 });
});

it("save_arrangement_changes refuses cells changed or emptied since they were typed over, naming every one, and saves nothing", async () => {
  const c2 = await customerWhoOrdersNothing();
  const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(10, 5);
  const r1 = await arrangeNow(line, customer.id, 3);
  const r2 = await arrangeNow(line, c2.id, 2);
  await arrangeNow(line, customer.id, 4); // somebody changed it
  expect((await admin.client.rpc("delete_arrangement_record", toDeleteArrangementRecordRpcArgs({ id: r2.id }))).error).toBeNull(); // and emptied this one
  const saved = await saveChanges(day.id, [
    { dailyPickProductId: line, customerCompanyId: customer.id, quantityPallets: 5, expected: { recordId: r1.id, quantityPallets: 3 } },
    { dailyPickProductId: line, customerCompanyId: c2.id, quantityPallets: 1, expected: { recordId: r2.id, quantityPallets: 2 } },
  ]);
  expect(saved.error?.code).toBe(ARRANGEMENT_ERROR_CODES.CONFLICT);
  expect(JSON.parse(saved.error?.details ?? "{}").cells.map((cell: { index: number }) => cell.index)).toEqual([0, 1]);
  expect(byCustomer(await recordsOn(line))).toEqual({ [customer.id]: 4 });
});

it("save_arrangement_changes moves pallets between two customers on a lot with nothing free, whichever is listed first", async () => {
  const c2 = await customerWhoOrdersNothing();
  const { day, pickProductId: line, customer } = await setUpDayWithSupplyAndDemand(5, 5);
  const r1 = await arrangeNow(line, customer.id, 5);
  const saved = await saveChanges(day.id, [
    { dailyPickProductId: line, customerCompanyId: c2.id, quantityPallets: 3, expected: EMPTY },
    { dailyPickProductId: line, customerCompanyId: customer.id, quantityPallets: 2, expected: { recordId: r1.id, quantityPallets: 5 } },
  ]);
  expect(saved.error).toBeNull();
  expect(byCustomer(await recordsOn(line))).toEqual({ [customer.id]: 2, [c2.id]: 3 });
});
```

Further cases. Each name is followed by what it asserts:
- "…refuses a cell meant for an order the customer withdrew, and saves nothing": withdraw the order line exactly as the proposal case at `arrangement.test.ts:486` does, then `[{ …customer, 3, EMPTY, forOrder: true }]` → `CONFLICT`, `recordsOn` = `[]`.
- "…keeps the price on a cell whose quantity it changes": `r = arrangeNow(line, customer, 2)`, then `update_arrangement_record` via `toUpdateArrangementRecordRpcArgs({ id: r.id, quantityPallets: 2, price: 12.5, priceType: PRICE_TYPES[0] })`, then save `3` with expected `{ r.id, 2 }` → the record's `price` is `12.5` and its quantity is `3`.
- "…is refused on a closed pick, saving nothing": `set_pick_closed` with `{ p_daily_pick_id: (await getDailyPickForGrower(day.id, grower.companyId))!.id, p_closed: true }`, then save `2` → `PICK_CLOSED`, `recordsOn` = `[]`.
- "…is refused once the arrangement has closed": close as the proposal case at `:622` does → `INVALID_STATE`.
- "…refuses anyone but backoffice, and saves nothing": `(await signedInWithoutProfile()).rpc("save_arrangement_changes", …)` → `42501`.
- "…refuses malformed changes, naming each by position": `saveChangesRaw` with six otherwise-valid elements broken as follows: `dailyPickProductId: "x"`; `quantityPallets: -1`; `quantityPallets: 0.55`; `quantityPallets: 0` with `EMPTY`; no `expected`; `forOrder: "yes"` → `P0008`, DETAIL `indexes` = `[0, 1, 2, 3, 4, 5]`.
- "…refuses a cell that appears twice, and changes that are not a list": a repeated cell → `P0008` with DETAIL `cells` of length 1; `saveChangesRaw(day.id, {})` → `P0008`.
- "…refuses a pick line on another day, naming it": `setUpEarlierDay(grower.companyId, grower.varietyId)` → `NOT_FOUND`, DETAIL `pickLineIds` = `[earlier.pickProductId]`.
- "…saves part of a pallet to one decimal place": `2.5` → saved, `recordsOn` quantity `2.5`.

- [ ] **Step 2: Run them to see them fail**

```bash
cd "$H" && TEST="d:/Downloads/Downloads/Ori main/packages/domain/src/arrangement/arrangement.test.ts" ONLY="save_arrangement_changes" WORLD_TAR="$H/world-bare.tar" SUPABASE_PORT=61321 node vitest-local.mjs 2>&1 | cut -c1-300 | tail -30
```

Expected: all 14 FAIL (the function does not exist yet: PGRST202).

- [ ] **Step 3: Write the migration.** Start with a header: the "UNAPPLIED until James confirms" line, what it does and why, as in 0075's header (R4 all or nothing, R6 rules in one place, R7 lock order), and a pointer to spec §5. The function is `language plpgsql security invoker set search_path = public`, and its body follows 0085's `save_arrangement_proposal` structure step for step. These parts differ:
  1. Per-element validation (P0008, `indexes`). Guard every cast with nested `CASE`, as 0075 does, because Postgres does not short-circuit `OR`. Both ids are uuid strings; `quantityPallets` is a number `>= 0` equal to `round(q, 1)`; `expected` is an object whose `recordId` is JSON null or a uuid string and whose `quantityPallets` is a number `>= 0` equal to `round(q, 1)`; `quantityPallets = 0` requires a string `expected.recordId`; `forOrder`, when present, is a boolean.
  2. Typed arrays, read once (0075 §"Read into typed columns ONCE"): `jsonb_to_recordset(p_changes) as ("dailyPickProductId" uuid, "customerCompanyId" uuid, "quantityPallets" numeric, "expected" jsonb, "forOrder" boolean)`, plus `v_expected_record_ids uuid[]` from `(expected ->> 'recordId')::uuid` and `v_expected_quantities numeric[]` from `(expected ->> 'quantityPallets')::numeric`.
  3. Repeated cells, pick lines on the day, and the four locks: as 0075.
  4. The changed-underneath check (P0006, `cells`):

```sql
select jsonb_agg(jsonb_build_object('index', a.ord - 1, 'dailyPickProductId', a.pick_line_id,
                                    'customerCompanyId', a.customer_id) order by a.ord)
  into v_bad
from unnest(v_pick_line_ids, v_customer_ids, v_expected_record_ids, v_expected_quantities)
       with ordinality as a(pick_line_id, customer_id, expected_record_id, expected_quantity, ord)
left join lateral (
  select ar.id, ar.quantity_pallets
  from public.arrangement_records ar
  left join public.daily_order_products dop on dop.id = ar.daily_order_product_id
  left join public.daily_orders o on o.id = dop.daily_order_id
  where ar.daily_pick_product_id = a.pick_line_id
    and (o.customer_company_id = a.customer_id or ar.customer_company_id = a.customer_id)
  limit 1
) cur on true
where (a.expected_record_id is null and cur.id is not null)
   or (a.expected_record_id is not null
       and (cur.id is distinct from a.expected_record_id
            or cur.quantity_pallets is distinct from a.expected_quantity));
```

  5. The `forOrder` check: as 0075, restricted to changes with `quantity > 0`.
  6. Apply, inside one exception block that re-raises with DETAIL `{index, dailyPickProductId, customerCompanyId, quantityPallets}` (as 0075):

```sql
for v_index, v_pick_line_id, v_customer_id, v_quantity, v_expected_record_id in
  select a.ord - 1, a.pick_line_id, a.customer_id, a.quantity, a.expected_record_id
  from unnest(v_pick_line_ids, v_customer_ids, v_quantities, v_expected_record_ids, v_expected_quantities)
         with ordinality as a(pick_line_id, customer_id, quantity, expected_record_id, expected_quantity, ord)
  -- Clears and decreases first: moving pallets between two customers on a
  -- full lot must not be refused for the moment both hold them.
  order by case when a.quantity < a.expected_quantity then 0 else 1 end, a.ord
loop
  if v_quantity = 0 then
    perform public.delete_arrangement_record(v_expected_record_id);
  else
    -- Price arguments left out: arrange_to_customer COALESCEs, so the record keeps its own.
    select * into v_record from public.arrange_to_customer(v_pick_line_id, v_customer_id, v_quantity);
    if v_expected_record_id is null and v_record.created_at is distinct from now() then
      raise exception 'CONFLICT: this cell was filled while the changes were being saved' using errcode = 'P0006';
    end if;
  end if;
  v_saved := v_saved + 1;
end loop;
```

  7. `comment on function …` listing the errors; then `revoke execute … from public, anon;` and `grant execute … to authenticated, service_role;`, each under a SECURITY comment saying what it allows and what it protects against (0075's closing block is the model).

- [ ] **Step 4: Add the journal entry and rebuild the migrations-only database**

```bash
cd "$H" && cp world-bare.tar world-bare-0102.tar && node bare-world.mjs
```

Expected: it prints the row counts with no error. `world-bare.tar` now includes 0103, and `world-bare-0102.tar` keeps the old one.

- [ ] **Step 5: Run the new cases, then the whole file**

Step 2's command → 14 PASS. Then the same without `ONLY=` → every case passes, the `save_arrangement_proposal` ones included.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/0103_save-arrangement-changes.sql packages/db/migrations/meta/_journal.json packages/domain/src/arrangement/arrangement.test.ts
git commit -m "feat(db): save_arrangement_changes saves the grid's changes all or nothing (0103)"   # + Co-Authored-By line
```

---

### Task 3: Grid overlay: unsaved cells with "set" semantics

**Files:**
- Modify: `apps/web/src/components/arrangement/matrix-data.ts`: `MatrixCell` (~line 52), `ProposedAllocation` (~205), `buildMatrix`'s `proposal` input and overlay (~229–368), the product row's own cell (~448–468), `orderedOnly` (~551–579)
- Modify: `matrix/row.tsx` (`BLANK_CELL` ~line 24; ~246–248; ~277–279), `arrangement-matrix-mobile.tsx` (~332; ~341–343), `matrix/cell-look.ts` (`UNSAVED_TITLE` and its comment)
- Modify: `arrangement-proposal.ts`: in `resolveProposal`'s `byCell.set(…)`, add `expected: { recordId: null, quantity: 0 }` (Task 4 makes it real)
- Test: `matrix-data.test.ts` (rewrite the describe at ~439–516; the `orderedOnly` describe's `day()` parameter type; one new case), `arrangement-proposal.test.ts` (~402 and ~1229: `proposed` → `unsaved`)

**Interfaces:**
- Produces:

```ts
interface MatrixCell { /* …unchanged fields… */
  /** The number shown is not what is saved: typed, cleared or suggested, and not saved yet.
   *  On a multi-grower product row's sum: true when any grower cell under it is. */
  unsaved: boolean;            // replaces `proposed: number`
}
interface ProposedAllocation {
  pickLineId: string;
  customerId: string;
  /** What the cell is to hold once saved; 0 removes the saved allocation. */
  quantity: number;
  forOrder?: boolean;
  /** What the cell held when the change was made — sent with the save (0103). */
  expected: { recordId: string | null; quantity: number };
}
buildMatrix({ …, proposal?: ReadonlyArray<Pick<ProposedAllocation, "pickLineId" | "customerId" | "quantity">> }): Matrix
// Overlay: per cell, the SUM of its allocations replaces the saved quantity; the line's total moves
// by (sum − saved); every cell named is unsaved; recordId / price / priceType are kept.
// orderedOnly: also keeps a column, and a row, holding an unsaved cell.
export const UNSAVED_TITLE = "עדיין לא נשמר";
```

- [ ] **Step 1: Write the failing tests.** Rename the describe to `"buildMatrix with unsaved changes"` and keep its `preview()` helper. Its cases:

```ts
it("1 shows a new number in an empty cell and marks it unsaved", () => {
  expect(preview().lychees.cells[0]).toMatchObject({ allocated: 3, unsaved: true, recordId: null });
});
it("2 takes it off what is still available on the lot", () => {
  const { lychees } = preview();
  expect(lychees.allocated).toBe(3);
  expect(lychees.available).toBe(4);
});
it("3 leaves a saved allocation unmarked", () => {
  expect(preview().lemons.growers[1]?.cells[1]).toMatchObject({ allocated: 2, unsaved: false, recordId: "record-1" });
});
it("4 carries an unsaved number on one grower's lot up into the product row's sum", () => {
  const { lemons } = preview([{ pickLineId: "line-a-lemon", customerId: CUSTOMER_2, quantity: 1 }]);
  expect(lemons.cells[1]).toMatchObject({ allocated: 3, unsaved: true });
  expect(lemons.growers[0]?.cells[1]).toMatchObject({ allocated: 1, unsaved: true });
  expect(lemons.available).toBe(12);
});
it("5 sets a saved cell to the unsaved number, keeping its record and price", () => {
  const { lemons } = preview([{ pickLineId: "line-b-lemon", customerId: CUSTOMER_2, quantity: 5 }]);
  expect(lemons.growers[1]?.cells[1]).toMatchObject({ allocated: 5, unsaved: true, recordId: "record-1", price: 12.5, priceType: "fixed" });
  expect(lemons.growers[1]?.allocated).toBe(5);
  expect(lemons.available).toBe(10);
});
it("6 clears a saved cell: shows it empty, marked unsaved, and frees its pallets", () => {
  const { lemons } = preview([{ pickLineId: "line-b-lemon", customerId: CUSTOMER_2, quantity: 0 }]);
  expect(lemons.growers[1]?.cells[1]).toMatchObject({ allocated: 0, unsaved: true, recordId: "record-1" });
  expect(lemons.available).toBe(15);
});
it("7 adds up two numbers for the same cell", () => {
  const { lychees } = preview([
    { pickLineId: "line-a-lychee", customerId: CUSTOMER_1, quantity: 3 },
    { pickLineId: "line-a-lychee", customerId: CUSTOMER_1, quantity: 2 },
  ]);
  expect(lychees.cells[0]).toMatchObject({ allocated: 5, unsaved: true });
  expect(lychees.available).toBe(2);
});
// plus: "marks nothing when nothing is unsaved" → every cell's `unsaved` is false
```

In the `orderedOnly` describe, change `day()`'s `proposal?` type to `Array<Pick<ProposedAllocation, "pickLineId" | "customerId" | "quantity">>`, then add:

```ts
it("8 keeps a product and a customer whose only pallets are being taken back, unsaved", () => {
  const cut = orderedOnly(day({
    dayOrdersOverride: pushedOrders,
    dayRecords: [pushedRecord],
    proposal: [{ pickLineId: "line-c-mango", customerId: CUSTOMER_3, quantity: 0 }],
  }));
  expect(varieties(cut)).toEqual([lemon.id, lychee.id, mango.id]);
  expect(customers(cut)).toEqual([CUSTOMER_1, CUSTOMER_2, CUSTOMER_3]);
});
```

In `arrangement-proposal.test.ts`, change the two `proposed` assertions (~402, ~1229) to `unsaved` booleans (a number above 0 → `true`).

- [ ] **Step 2: Run them to see them fail**

```bash
cd "d:/Downloads/Downloads/Ori main" && pnpm --filter @ori/web exec vitest run src/components/arrangement
```

Expected: cases 1–8 FAIL (`unsaved` undefined; 5 and 6 still add on top).

- [ ] **Step 3: Implement.** The overlay runs after the records pass and replaces the current proposal loop:

```ts
const unsavedByCell = new Map<string, { pickLineId: string; quantity: number }>();
for (const allocation of proposal) {
  const key = `${allocation.pickLineId}${SEP}${allocation.customerId}`;
  const sum = roundPallets((unsavedByCell.get(key)?.quantity ?? 0) + allocation.quantity);
  unsavedByCell.set(key, { pickLineId: allocation.pickLineId, quantity: sum });
}
for (const [key, { pickLineId, quantity }] of unsavedByCell) {
  const saved = cellByPickLineCustomer.get(key);
  allocatedByPickLine.set(pickLineId,
    roundPallets((allocatedByPickLine.get(pickLineId) ?? 0) - (saved?.allocated ?? 0) + quantity));
  cellByPickLineCustomer.set(key, { allocated: quantity, unsaved: true, recordId: saved?.recordId ?? null,
    price: saved?.price ?? null, priceType: saved?.priceType ?? null });
}
```

The product row's own cell gets `unsaved: growers.some((grower) => grower.cells[index]?.unsaved === true)`. In `orderedOnly`, a column is kept when some row's cell has `ordered > 0 || allocated > 0 || unsaved`; a row is kept when `row.ordered > 0 || row.allocated > 0 || row.cells.some((cell) => cell.unsaved)`. In `row.tsx` and the mobile list, `cell.proposed > 0` becomes `cell.unsaved`, and `BLANK_CELL` gets `unsaved: false`. Update the doc comments that describe `proposed` / "a proposal on preview".

- [ ] **Step 4: Run the tests and typecheck**

Step 2's command → PASS; `pnpm --filter @ori/web typecheck` → no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/arrangement/matrix-data.ts apps/web/src/components/arrangement/matrix-data.test.ts apps/web/src/components/arrangement/matrix/row.tsx apps/web/src/components/arrangement/arrangement-matrix-mobile.tsx apps/web/src/components/arrangement/matrix/cell-look.ts apps/web/src/components/arrangement/arrangement-proposal.ts apps/web/src/components/arrangement/arrangement-proposal.test.ts
git commit -m "refactor(arrangement): the grid marks unsaved cells, and a change replaces a saved number"   # + Co-Authored-By line
```

---

### Task 4: Unsaved lines: typing over saved cells, re-reads, conflicts

**Files:**
- Modify: `apps/web/src/components/arrangement/arrangement-proposal.ts`
- Test: `apps/web/src/components/arrangement/arrangement-proposal.test.ts`

**Interfaces:**
- Consumes: `ProposedAllocation` with `expected` (Task 3).
- Produces (all exported from `arrangement-proposal.ts`):

```ts
interface ProposalLine {
  growerId: string; varietyId: string; customerId: string;
  /** What the cell is to hold. 0 only together with `expected`: remove the saved allocation. */
  quantity: number;
  forOrder?: "suggested" | "typed";
  /** The saved allocation this line was typed over, as it stood then. Absent when the cell was
   *  empty then, and on every suggestion. Kept as first recorded when the cell is typed again. */
  expected?: { recordId: string; quantity: number };
}
interface ResolvedProposal {
  allocations: ProposedAllocation[];  // quantity 0 = removal; expected = line.expected ?? { recordId: null, quantity: 0 }
  alreadyArranged: number;            // suggestions whose cell is filled
  unplaceable: number;
  heldToOrder: number;                // suggestions only
  alreadySaved: number;               // lines whose cell already holds their number
  suggestedCells: number;             // distinct cells holding a suggestion, after cutting
  suggestedPallets: number;
}
type DayRows = { picks: BoardPick[]; orders: readonly BoardOrder<BoardSubmissionTime>[]; records: readonly BoardRecord[] };
function savedAllocation(day: Pick<DayRows, "orders" | "records">, pickLineId: string, customerId: string): { recordId: string; quantity: number } | null;
function setUnsavedCell(lines: ProposalLine[], cell: { growerId: string; varietyId: string; customerId: string },
  quantity: number, context: { forOrder: boolean; saved: { recordId: string; quantity: number } | null }): ProposalLine[];
function typeIntoUnsaved(lines: ProposalLine[], day: DayRows, write: { pickLineId: string; customerId: string; quantity: number }): ProposalLine[] | null;
function dropCells(lines: ProposalLine[], picks: BoardPick[], cells: ReadonlyArray<{ pickLineId: string; customerId: string }>): ProposalLine[];
function pruneSaved(lines: ProposalLine[], day: DayRows): ProposalLine[];
// setProposalCell and typeIntoProposal stay until Task 6 removes them.
```

The rules these implement (spec §4.1, §4.4, §4.5):
- `savedAllocation`: the record on that pick line whose order line belongs to that customer, OR whose own `customer_company_id` is that customer (the same two names `resolveProposal` already treats as one cell).
- `setUnsavedCell`: if the quantity fails `isPalletQuantity`, return `lines` unchanged. Otherwise `expected` = the first existing line's `expected` for that cell if a line exists, else `context.saved ?? undefined`. If `roundPallets(quantity) === (expected?.quantity ?? 0)`, remove every line for the cell. Otherwise put one typed line `{ …cell, quantity: roundPallets(quantity), forOrder: context.forOrder ? "typed" : undefined, expected }` where the first existing line stood, dropping the cell's other lines, or append it.
- `typeIntoUnsaved`: `lotOfPickLine` → `null` if there is no lot. Otherwise `setUnsavedCell` with `saved = savedAllocation(day, …)` and `forOrder` = the customer has an order line above 0 for the lot's variety (`orderedPallets`).
- `resolveProposal`:
  - Placeable = lot found, customer trading, `isPalletQuantity(q)`, and `q > 0 || line.expected`.
  - A **suggested** line on a filled cell → `alreadyArranged`; a suggested line with no order → `heldToOrder` (both unchanged).
  - A **typed** line lands even on a filled cell, and even when its order has gone; `forOrder` stays `true` on its allocation.
  - Any line whose cell's saved quantity (0 when empty) equals its quantity → `alreadySaved`, not landed.
  - In the order-holding pass, a typed entry takes `quantity − savedQuantityOfItsCell` off `owed`.
- `dropCells`: remove every line whose `(lot of pickLineId, customerId)` is one of `cells`.
- `pruneSaved`: remove every line whose cell (via `resolveProposal`'s pick-line lookup) currently holds exactly its quantity.
- `saveRefusalMessage`: the conflict wording becomes the two Global Constraints strings.

- [ ] **Step 1: Write the failing tests.** These new describes use the file's fixtures (`picks`, `orders`, `savedLemons` = record-1, 2 pallets of grower B's lemons to CUSTOMER_2, who ordered 3):

```ts
const B_LEMON_C2 = { growerId: GROWER_B, varietyId: LEMON, customerId: CUSTOMER_2 };
const SAVED = { recordId: "record-1", quantity: 2 };
const day = (records: BoardRecord[] = [savedLemons]) => ({ picks, orders, records });

describe("setUnsavedCell", () => {
  it("typed over a saved cell, remembers what the cell held", () => {
    expect(setUnsavedCell([], B_LEMON_C2, 5, { forOrder: true, saved: SAVED }))
      .toEqual([{ ...B_LEMON_C2, quantity: 5, forOrder: "typed", expected: SAVED }]);
  });
  it("typed back to the saved number, is no change at all", () => {
    const lines = setUnsavedCell([], B_LEMON_C2, 5, { forOrder: true, saved: SAVED });
    expect(setUnsavedCell(lines, B_LEMON_C2, 2, { forOrder: true, saved: SAVED })).toEqual([]);
  });
  it("emptying a saved cell is a removal", () => {
    expect(setUnsavedCell([], B_LEMON_C2, 0, { forOrder: true, saved: SAVED }))
      .toEqual([{ ...B_LEMON_C2, quantity: 0, forOrder: "typed", expected: SAVED }]);
  });
  it("emptying an empty cell leaves nothing", () => {
    expect(setUnsavedCell([], { growerId: GROWER_A, varietyId: LYCHEE, customerId: CUSTOMER_1 }, 0, { forOrder: true, saved: null })).toEqual([]);
  });
  it("keeps what the cell held when it was first typed over", () => {
    const lines = setUnsavedCell([], B_LEMON_C2, 5, { forOrder: true, saved: SAVED });
    expect(setUnsavedCell(lines, B_LEMON_C2, 6, { forOrder: true, saved: { recordId: "record-9", quantity: 4 } })[0]?.expected).toEqual(SAVED);
  });
  it("a quantity finer than a tenth changes nothing", () => {
    const lines = [line(GROWER_A, LYCHEE, CUSTOMER_1, 3)];
    expect(setUnsavedCell(lines, { growerId: GROWER_A, varietyId: LYCHEE, customerId: CUSTOMER_1 }, 2.55, { forOrder: true, saved: null })).toBe(lines);
  });
});

describe("typeIntoUnsaved", () => {
  it("finds the saved allocation behind the cell", () => {
    expect(typeIntoUnsaved([], day(), { pickLineId: "line-b-lemon", customerId: CUSTOMER_2, quantity: 4 }))
      .toEqual([{ ...B_LEMON_C2, quantity: 4, forOrder: "typed", expected: SAVED }]);
  });
  it("a push into an empty cell is neither for an order nor over anything", () => {
    expect(typeIntoUnsaved([], day(), { pickLineId: "line-a-lemon", customerId: CUSTOMER_3, quantity: 1 }))
      .toEqual([{ growerId: GROWER_A, varietyId: LEMON, customerId: CUSTOMER_3, quantity: 1 }]);
  });
  it("is null for a lot that is not on the day", () => {
    expect(typeIntoUnsaved([], day(), { pickLineId: "line-x", customerId: CUSTOMER_1, quantity: 1 })).toBeNull();
  });
});

describe("resolveProposal with typed changes", () => {
  it("lands a typed number over a saved cell, with what it replaces", () => {
    expect(resolve([{ ...B_LEMON_C2, quantity: 5, forOrder: "typed", expected: SAVED }]).allocations).toEqual([
      { pickLineId: "line-b-lemon", customerId: CUSTOMER_2, quantity: 5, forOrder: true, expected: SAVED },
    ]);
  });
  it("lands a removal", () => {
    expect(resolve([{ ...B_LEMON_C2, quantity: 0, forOrder: "typed", expected: SAVED }]).allocations[0]?.quantity).toBe(0);
  });
  it("keeps a typed number whose empty cell somebody filled since, for the save to refuse", () => {
    const resolved = resolve([{ ...B_LEMON_C2, quantity: 3, forOrder: "typed" }]);
    expect(resolved.allocations).toEqual([
      { pickLineId: "line-b-lemon", customerId: CUSTOMER_2, quantity: 3, forOrder: true, expected: { recordId: null, quantity: 0 } },
    ]);
    expect(resolved.alreadyArranged).toBe(0);
  });
  it("still drops a suggestion whose cell is filled", () => {
    const resolved = resolve([{ ...B_LEMON_C2, quantity: 1, forOrder: "suggested" }]);
    expect(resolved.allocations).toEqual([]);
    expect(resolved.alreadyArranged).toBe(1);
  });
  it("keeps a number typed for an order the customer withdrew, still marked for the order", () => {
    const withdrawn = orders.map((order) => (order.id === "order-2" ? { ...order, daily_order_products: [] } : order));
    const resolved = resolveProposal({ lines: [{ growerId: GROWER_A, varietyId: LEMON, customerId: CUSTOMER_2, quantity: 1, forOrder: "typed" }], picks, orders: withdrawn, records: [] });
    expect(resolved.allocations).toEqual([{ pickLineId: "line-a-lemon", customerId: CUSTOMER_2, quantity: 1, forOrder: true, expected: { recordId: null, quantity: 0 } }]);
    expect(resolved.heldToOrder).toBe(0);
  });
  it("counts a line whose cell already holds its number as already saved", () => {
    const resolved = resolve([{ ...B_LEMON_C2, quantity: 2, forOrder: "typed", expected: SAVED }]);
    expect(resolved.allocations).toEqual([]);
    expect(resolved.alreadySaved).toBe(1);
  });
  it("holds a suggestion to what a typed change leaves of the order, replacing the saved number rather than adding to it", () => {
    // Ordered 3; saved 2 on B is changed to 1, so 2 are left for the suggestion of 3 on A.
    const resolved = resolve([
      { ...B_LEMON_C2, quantity: 1, forOrder: "typed", expected: SAVED },
      { growerId: GROWER_A, varietyId: LEMON, customerId: CUSTOMER_2, quantity: 3, forOrder: "suggested" },
    ]);
    expect(resolved.allocations.find((a) => a.pickLineId === "line-a-lemon")?.quantity).toBe(2);
    expect(resolved.heldToOrder).toBe(1);
  });
  it("counts suggested cells and pallets", () => {
    const resolved = resolve([{ growerId: GROWER_A, varietyId: LYCHEE, customerId: CUSTOMER_1, quantity: 3, forOrder: "suggested" }]);
    expect([resolved.suggestedCells, resolved.suggestedPallets]).toEqual([1, 3]);
  });
});

describe("dropCells and pruneSaved", () => {
  const lychee = { growerId: GROWER_A, varietyId: LYCHEE, customerId: CUSTOMER_1, quantity: 4, forOrder: "typed" as const };
  it("dropCells removes the lines of the cells named", () => {
    const lines = [{ ...B_LEMON_C2, quantity: 5, forOrder: "typed" as const, expected: SAVED }, lychee];
    expect(dropCells(lines, picks, [{ pickLineId: "line-b-lemon", customerId: CUSTOMER_2 }])).toEqual([lychee]);
  });
  it("pruneSaved removes a line whose cell already holds its number", () => {
    const lines = [{ ...B_LEMON_C2, quantity: 2, forOrder: "typed" as const, expected: SAVED }, lychee];
    expect(pruneSaved(lines, day())).toEqual([lychee]);
  });
});
```

Change the conflict strings in the existing `saveRefusalMessage` describe (~line 1364) to the new copy.

- [ ] **Step 2: Run them to see them fail**

`pnpm --filter @ori/web exec vitest run src/components/arrangement/arrangement-proposal.test.ts` → the new cases FAIL (not exported, or old rules).

- [ ] **Step 3: Implement** the interface and rules above in `arrangement-proposal.ts`. Build the saved-cell index once per `resolveProposal` call, not per line.

- [ ] **Step 4: Bring pre-existing cases in line with the spec, then run.** Re-run the file. Any pre-existing case that asserts a **typed** line (`forOrder: "typed"` or none) is dropped because its cell is filled or its order has gone now contradicts spec §4.4: change its expectation to "lands, `forOrder` kept, `expected: { recordId: null, quantity: 0 }`". Cases about **suggested** lines must pass unchanged (§4.5). Then the file passes in full, and `pnpm --filter @ori/web typecheck` is clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/arrangement/arrangement-proposal.ts apps/web/src/components/arrangement/arrangement-proposal.test.ts
git commit -m "feat(arrangement): unsaved changes can replace or clear a saved number"   # + Co-Authored-By line
```

---

### Task 5: The unsaved-changes store

**Files:**
- Create: `apps/web/src/components/arrangement/unsaved-changes.tsx`
- Modify: `apps/web/src/routes/backoffice/layout.tsx` (wrap the children of `SelectedTradingDayProvider` in `UnsavedChangesProvider`)
- Test: `apps/web/src/components/arrangement/unsaved-changes.test.ts`

**Interfaces:**
- Consumes: `ProposalLine` (Task 4).
- Produces:

```ts
export interface UnsavedDay { lines: ProposalLine[]; refusal: string | null }
export const EMPTY_UNSAVED_DAY: UnsavedDay;   // { lines: [], refusal: null }, frozen
export function updateUnsavedDay(all: ReadonlyMap<string, UnsavedDay>, tradingDayId: string,
  update: (current: UnsavedDay) => UnsavedDay): ReadonlyMap<string, UnsavedDay>;
// same map back when `update` returns the current object; the day removed when the result has
// no lines and no refusal; otherwise a new map with that day replaced.
export function UnsavedChangesProvider(props: { children: ReactNode }): JSX.Element;
export function useUnsavedChanges(): {
  dayOf: (tradingDayId: string) => UnsavedDay;   // EMPTY_UNSAVED_DAY when none
  updateDay: (tradingDayId: string, update: (current: UnsavedDay) => UnsavedDay) => void;  // stable identity
};
// throws "useUnsavedChanges must be used inside UnsavedChangesProvider" outside it.
```

Memory only: no `localStorage` or `sessionStorage` (spec §4.4). The file's header comment explains three things. It is mounted in the backoffice layout, so it outlives each screen. `lib/providers.tsx` remounts everything below its keyed `ToastProvider` whenever the account changes, which empties it on sign-out or account switch. And a reload empties it. `updateDay` is a `useCallback` over a functional `setState`, because the save's callbacks call it after the grid has unmounted.

- [ ] **Step 1: Write the failing tests**

```ts
const L1 = { growerId: "g", varietyId: "v", customerId: "c1", quantity: 1 };
const L2 = { growerId: "g", varietyId: "v", customerId: "c2", quantity: 2 };
it("keeps each trading day's changes apart", () => {
  const one = updateUnsavedDay(new Map(), "d1", () => ({ lines: [L1], refusal: null }));
  const two = updateUnsavedDay(one, "d2", () => ({ lines: [L2], refusal: null }));
  expect(two.get("d1")?.lines).toEqual([L1]);
  expect(two.get("d2")?.lines).toEqual([L2]);
});
it("drops a day once it holds no lines and no message", () => {
  const one = updateUnsavedDay(new Map(), "d1", () => ({ lines: [L1], refusal: null }));
  expect(updateUnsavedDay(one, "d1", () => EMPTY_UNSAVED_DAY).has("d1")).toBe(false);
});
it("hands the update the day's current changes, or the empty day", () => {
  const seen: UnsavedDay[] = [];
  updateUnsavedDay(new Map(), "d1", (current) => { seen.push(current); return current; });
  expect(seen).toEqual([EMPTY_UNSAVED_DAY]);
});
it("returns the same map when nothing changes", () => {
  const one = updateUnsavedDay(new Map(), "d1", () => ({ lines: [L1], refusal: null }));
  expect(updateUnsavedDay(one, "d1", (current) => current)).toBe(one);
});
```

- [ ] **Step 2: Run them to see them fail**: `pnpm --filter @ori/web exec vitest run src/components/arrangement/unsaved-changes.test.ts` → FAIL (no module).
- [ ] **Step 3: Implement** the file and mount the provider in `layout.tsx`.
- [ ] **Step 4: Run the tests and typecheck** → PASS, and `pnpm --filter @ori/web typecheck` clean.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/arrangement/unsaved-changes.tsx apps/web/src/components/arrangement/unsaved-changes.test.ts apps/web/src/routes/backoffice/layout.tsx
git commit -m "feat(arrangement): keep the grid's unsaved changes across screens, per account and day"   # + Co-Authored-By line
```

---

### Task 6: The grid records changes; one button saves them

**Files:**
- Modify: `apps/web/src/routes/backoffice/new-arrangement.tsx`
- Modify: `apps/web/src/components/arrangement/arrangement-proposal.ts` (delete `setProposalCell`, `typeIntoProposal`) and `arrangement-proposal.test.ts` (delete the describes `setProposalCell` and `typeIntoProposal`; in `a proposal while it is being corrected`, switch calls to `setUnsavedCell` / `typeIntoUnsaved` with `saved: null` for empty cells, and delete assertions about `saveNow`)

**Interfaces:**
- Consumes: Task 1 (`saveArrangementChangesInputSchema`, `toSaveArrangementChangesRpcArgs`); Task 4 (`resolveProposal`, `typeIntoUnsaved`, `dropCells`, `pruneSaved`, `refusedCells`, `saveRefusalMessage`, `ProposalLine`); Task 5 (`useUnsavedChanges`, `EMPTY_UNSAVED_DAY`); `Dialog` from `@/components/ui/dialog` (`open`, `onClose`, `title`, `children`).
- Produces: `SAVE_CHANGES_KEY = ["new-arrangement", "save-changes"] as const`.

There's no component-test setup in `apps/web` (Node environment, no React Testing Library). This task is checked by typecheck, lint and unit tests here, and by the e2e test in Task 7.

- [ ] **Step 1: Remove the per-cell write path.** Delete `suggestion` state and its drop-in-render block, `SAVE_PROPOSAL_KEY`/`savingProposal`, `recordsOptimistic`, `arrangeOptimistic`, `arrangeMutation`, `deleteOptimistic`, `deleteMutation`, `saveProposalMutation`, `saveSuggestion`, `invalidateBoards`, and the "שומר הצעת סידור…" pill. Then remove the imports this leaves unused. Rewrite the file header's "Every write is arrange_to_customer…" paragraph and the `commitCell` doc to describe the new flow: nothing is written while typing; `שמור שינויים` saves through `save_arrangement_changes` (0103).
- [ ] **Step 2: Wire the store.**

```ts
const { dayOf, updateDay } = useUnsavedChanges();
const unsaved = boardDay ? dayOf(boardDay.id) : EMPTY_UNSAVED_DAY;
const savingChanges = useIsMutating({ mutationKey: SAVE_CHANGES_KEY }) > 0;
const proposal = useMemo(() => (boardDay && editable && unsaved.lines.length > 0
  ? resolveProposal({ lines: unsaved.lines, picks: boardDay.daily_picks, orders: boardDay.daily_orders,
      records: arrangement?.arrangement_records ?? [] })
  : null), [boardDay, arrangement, editable, unsaved.lines]);
// A day that can no longer be edited has nothing to save into (spec §4.4). An effect, not a
// render-time update: the store lives in a parent component.
const hasUnsaved = unsaved.lines.length > 0 || unsaved.refusal !== null;
useEffect(() => {
  if (boardDay && !editable && !savingChanges && hasUnsaved) updateDay(boardDay.id, () => EMPTY_UNSAVED_DAY);
}, [boardDay, editable, savingChanges, hasUnsaved, updateDay]);
```

- [ ] **Step 3: `commitCell` records instead of writing.** It keeps its `(write: MatrixWrite) => Promise<boolean>` shape, so neither grid component changes:

```ts
const commitCell = async (write: MatrixWrite): Promise<boolean> => {
  if (!boardDay) return false;
  const rows = { picks: boardDay.daily_picks, orders: boardDay.daily_orders, records: arrangement?.arrangement_records ?? [] };
  if (!typeIntoUnsaved(unsaved.lines, rows, write)) return false;
  // Applied to the lines as they stand when the update runs: two quick commits must both land.
  updateDay(boardDay.id, (current) => ({ ...current, lines: typeIntoUnsaved(current.lines, rows, write) ?? current.lines }));
  return true;
};
```

- [ ] **Step 4: The save.** `useMutation({ mutationKey: SAVE_CHANGES_KEY, … })`, with variables `{ tradingDayId: string; allocations: ProposedAllocation[]; sent: readonly ProposalLine[] }`. Its callbacks sit on the hook, so they still run after the grid unmounts.
  - `mutationFn`: parse with `saveArrangementChangesInputSchema`, mapping each allocation to `{ dailyPickProductId, customerCompanyId, quantityPallets: quantity, expected: { recordId, quantityPallets: expected.quantity }, ...(forOrder ? { forOrder: true } : {}) }`; call `supabase.rpc("save_arrangement_changes", toSaveArrangementChangesRpcArgs(parsed))`; throw its error.
  - `onSuccess(saved, { tradingDayId, sent })`: `void` invalidate `arrangementKeys.boardDataAll`; `await` invalidate `newArrangementKeys.matrixAll`; `updateDay(tradingDayId, (c) => ({ lines: c.lines.filter((l) => !sent.includes(l)), refusal: null }))`; toast `` `הסידור נשמר: ${saved} תאים.` `` (`"success"`).
  - `onError(error: RpcError, { tradingDayId })`: the same two invalidations (await the matrix one). Then `fresh = queryClient.getQueryData<MatrixDay | null>(arrangementQueries.matrix(tradingDayId).queryKey)`; `reason = saveRefusalMessage({ error, picks: fresh?.daily_picks ?? [], names, reason: describeRpcError(error, "0103") })`. Then `updateDay`: when `fresh` exists, drop the refused cells' lines on `P0006` (`dropCells(lines, fresh.daily_picks, refusedCells(error.details))`), then `pruneSaved` against `fresh`; always set `refusal: reason`. Finally, toast `reason` (`"error"`).
  - `saveChanges()`: guard on `!boardDay || !proposal || savingChanges || saveRequested.current || proposal.allocations.length === 0`. Clear `refusal`, then `mutate({ tradingDayId: boardDay.id, allocations: proposal.allocations, sent: unsaved.lines }, { onSettled: () => { saveRequested.current = false; } })`.
- [ ] **Step 5: The bar, legend, hint and discard dialog** (copy from Global Constraints):
  - `unsavedCount = proposal?.allocations.length ?? 0`; `showBar = editable && (unsavedCount > 0 || unsaved.refusal !== null)`.
  - The bar replaces the proposal banner's JSX and keeps its container and `role="status"`. It holds the count sentence (when `unsavedCount > 0`), the proposal sentence (when `proposal.suggestedCells > 0`), today's left-out and held-to-order sentences, and the refusal line. Then the buttons: `שמור שינויים` (disabled while saving or when `unsavedCount === 0`; shows `שומר…` while saving) and `בטל שינויים` (secondary; disabled while saving; opens the dialog).
  - The legend shows while `showBar`. The desktop hint uses the new copy. `gridEditable = editable && !savingChanges`.
  - The dialog sets `EMPTY_UNSAVED_DAY` for the day on confirm, which also clears a leftover message.
- [ ] **Step 6: הצע סידור.** Show the button when `gridEditable && unsaved.lines.length === 0`. `suggestArrangement` also returns early when lines exist, and stores its result with `updateDay(today.id, () => ({ lines, refusal: null }))` in place of `setSuggestion(…)`.
- [ ] **Step 7: Delete `setProposalCell` and `typeIntoProposal`, with their tests** (see Files).
- [ ] **Step 8: Check**

```bash
cd "d:/Downloads/Downloads/Ori main" && pnpm --filter @ori/web typecheck && pnpm --filter @ori/web lint && pnpm --filter @ori/web test
```

Expected: no errors, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/routes/backoffice/new-arrangement.tsx apps/web/src/components/arrangement/arrangement-proposal.ts apps/web/src/components/arrangement/arrangement-proposal.test.ts
git commit -m "feat(arrangement): the products grid saves only with שמור שינויים"   # + Co-Authored-By line
```

---

### Task 7: e2e, full local verification, hand-off

**Files:**
- Modify: `apps/web/e2e/arrangement.spec.ts` (the grid section, ~lines 203–221)
- Modify: the spec's status line (`docs/superpowers/specs/2026-11-13-products-grid-save-button-design.md`)
- Local only (harness, not committed): `$H/scenarios/s15-grid-save.mjs`, `$H/make-after-world-0103.mjs`, selectors in `$H/scenarios/s05-proposal.mjs`

- [ ] **Step 1: Rewrite the grid section.** It replaces the "fill 5 → Enter" through "99 refused" lines. Keep the comment style of the spec:

```ts
const matrixCell = page.getByLabel(`${grower.varietyName} — ${customerCompany.name}`, { exact: true });
const saveButton = page.getByRole("button", { name: "שמור שינויים" });
const search = page.getByPlaceholder("חיפוש מוצר…");
await expect(matrixCell).toHaveValue("");

// 1. Enter only moves on; the number waits, marked unsaved, for שמור שינויים (James, 2026-11-13).
await matrixCell.fill("5");
await matrixCell.press("Enter");
await expect(matrixCell).toHaveValue("5");
await expect(matrixCell).toHaveAttribute("title", "עדיין לא נשמר");
await expect(page.getByText("שינוי אחד שלא נשמר.")).toBeVisible();
const written = await adminClient.from("arrangement_records").select("id").eq("daily_pick_product_id", pickLine!.id);
expect(written.data).toEqual([]); // nothing is written while typing
await saveButton.click();
await expect(page.getByText("הסידור נשמר: 1 תאים.")).toBeVisible();
await expect(matrixCell).not.toHaveAttribute("title", "עדיין לא נשמר");

// 2. A refused save saves nothing and keeps the number to correct; discarding asks first.
await matrixCell.fill("99");
await matrixCell.press("Enter");
await saveButton.click();
await expect(page.getByText(/חורגת ממה שנקטף/).first()).toBeVisible();
await expect(matrixCell).toHaveValue("99");
await page.getByRole("button", { name: "בטל שינויים" }).click();
await page.locator("dialog[open]").getByRole("button", { name: "בטל שינויים" }).click();
await expect(matrixCell).toHaveValue("5");

// 3. Someone else changes the same cell meanwhile: refused, named, their number shows.
await matrixCell.fill("4");
await matrixCell.press("Enter");
const theirs = await adminClient.rpc("arrange_to_customer", {
  p_daily_pick_product_id: pickLine!.id, p_customer_company_id: customerCompany.id, p_quantity_pallets: 2,
});
if (theirs.error) throw theirs.error;
await saveButton.click();
await expect(page.getByText(/השתנו בינתיים/).first()).toBeVisible();
await expect(matrixCell).toHaveValue("2");
await expect(matrixCell).not.toHaveAttribute("title", "עדיין לא נשמר");

// 4. Leaving while the save is still on its way: it lands anyway.
await matrixCell.fill("5");
await matrixCell.press("Enter");
await page.route("**/rest/v1/rpc/save_arrangement_changes", async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await route.continue();
});
await saveButton.click();
await page.getByRole("link", { name: "לסידור לפי מגדל" }).click();
await expect(page.getByText("הסידור נשמר: 1 תאים.")).toBeVisible({ timeout: 10000 });
await page.unroute("**/rest/v1/rpc/save_arrangement_changes");
await page.getByRole("link", { name: "סידור לפי מוצרים" }).click();
await search.fill(grower.varietyName);
await expect(matrixCell).toHaveValue("5");
// The bar, not page text: a closed <dialog> keeps its words in the DOM.
await expect(page.getByRole("status").filter({ hasText: "שלא נשמר" })).toHaveCount(0);

// Unsaved numbers survive switching screens…
await matrixCell.fill("3");
await matrixCell.press("Enter");
await page.getByRole("link", { name: "לסידור לפי מגדל" }).click();
await page.getByRole("link", { name: "סידור לפי מוצרים" }).click();
await search.fill(grower.varietyName);
await expect(matrixCell).toHaveValue("3");
await expect(matrixCell).toHaveAttribute("title", "עדיין לא נשמר");

// …a reload drops them (James: fine to lose on reload)…
await page.reload();
await search.fill(grower.varietyName);
await expect(matrixCell).toHaveValue("5");
await matrixCell.fill("3");
await matrixCell.press("Enter");

// 5. …and so does signing out and back in.
await page.getByRole("button", { name: "התנתקות" }).click();
await page.getByLabel("אימייל").fill(admin.email);
await page.getByLabel("סיסמה", { exact: true }).fill(admin.password);
await page.getByRole("button", { name: "התחברות" }).click();
await expect(page).toHaveURL(/\/backoffice\/shop$/);
await page.getByRole("link", { name: "סידור לפי מוצרים" }).click();
await search.fill(grower.varietyName);
await expect(matrixCell).toHaveValue("5");
await expect(matrixCell).not.toHaveAttribute("title", "עדיין לא נשמר");
```

The board section that follows (`חולק 5`, `נותר 5`) is unchanged.

- [ ] **Step 2: Build for the harness and run the spec**

```bash
cd "d:/Downloads/Downloads/Ori main/apps/web" && SUPABASE_PORT=61321 API_PORT=61399 node "$H/build-plain.mjs" "$OUT/dist-grid"
cd "$H" && SPEC="d:/Downloads/Downloads/Ori main/apps/web/e2e/arrangement.spec.ts" DIST_DIR="$OUT/dist-grid" WORLD_TAR="$H/world-bare.tar" SUPABASE_PORT=61321 API_PORT=61399 APP_PORT=4673 node e2e-local.mjs 2>&1 | cut -c1-300 | tail -15
```

Expected: `arrangement.spec.ts: 1/1 passed`. (The build must run with cwd `apps/web`, or Tailwind emits an unstyled ~15 KB CSS.)

- [ ] **Step 3: The whole e2e suite**

```bash
cd "$H" && SUPABASE_PORT=61321 API_PORT=61399 APP_PORT=4673 bash run-all-e2e.sh "$OUT/dist-grid" grid-save && cat "$H/out/e2e-grid-save/status.txt"
```

Expected: every spec `exit=0` (31/31 as of 2026-11-13), then `ALL DONE`.

- [ ] **Step 4: Scenario s15, "closed while unsaved" (Review Focus 3).** Make the seeded world with 0103: copy `make-after-world.mjs` to `make-after-world-0103.mjs`, point it at `0103_save-arrangement-changes.sql`, and change its before/after check to `select count(*)::int as n from pg_proc where proname = 'save_arrangement_changes'` (0 → 1). Run `node make-after-world-0103.mjs world world-0103`. Then write `scenarios/s15-grid-save.mjs` in s05's style (`openAs(browser, "bo")`, `check`, `note`, `rpc`):
  - open `/backoffice/new-arrangement`, type `0.1` into the first `input[data-cell]`, press Enter, and check that `[title="עדיין לא נשמר"]` count ≥ 1;
  - close the day through `rpc("bo", …)` as `s10-day-cycle.mjs` does (`close_shop`, then `close_arrangement`);
  - check that within 10 s the page shows no `[title="עדיין לא נשמר"]` and no bar (`getByRole("status").filter({ hasText: "שלא נשמר" })` count 0; not a page-wide text search, because a closed `<dialog>` keeps its words in the DOM), and that no arrangement record holds 0.1 pallets.

  Run it:

```bash
cd "$H" && SPEC="$H/scenarios/s15-grid-save.mjs" DIST_DIR="$OUT/dist-grid" WORLD_TAR="$H/world-0103.tar" SHIFT_TO_DAY="$(node -e "console.log(require('./world.json').today)")" SUPABASE_PORT=61321 API_PORT=61399 APP_PORT=4673 node e2e-local.mjs 2>&1 | cut -c1-300 | tail -15
```

  Expected: all checks pass. Point `s05-proposal.mjs` at the new UI (`שמור שינויים`; the bar as `getByRole("status").filter({ hasText: "שלא נשמר" })`) and re-run it the same way. Expected: it passes.

- [ ] **Step 5: Final checks across the repo**

```bash
cd "d:/Downloads/Downloads/Ori main" && pnpm typecheck && pnpm lint && pnpm --filter @ori/web test
cd "$H" && TEST="d:/Downloads/Downloads/Ori main/packages/domain/src/arrangement/arrangement.test.ts" WORLD_TAR="$H/world-bare.tar" SUPABASE_PORT=61321 node vitest-local.mjs 2>&1 | tail -5
```

Expected: no errors; every test passes.

- [ ] **Step 6: Mark the spec implemented and commit**

Set the spec's status line to `**Status:** approved 2026-11-13 · implemented on feat/grid-save-button`.

```bash
git add apps/web/e2e/arrangement.spec.ts docs/superpowers/specs/2026-11-13-products-grid-save-button-design.md
git status
git commit -m "test(e2e): the products grid saves only with שמור שינויים"   # + Co-Authored-By line
```

- [ ] **Step 7: Hand off (no push).** Tell James, in plain words:
  1. Run `packages/db/migrations/0103_save-arrangement-changes.sql` on production, and say when it's done.
  2. After that, and only on his go-ahead: merge `feat/grid-save-button` into main, push, and confirm the live bundle carries the new commit (grep `version:\`<sha7>\`` in the live `index-*.js`).
