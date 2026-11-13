-- UNAPPLIED until James confirms he has run it on production. It runs before
-- the web app whose save button calls it is pushed (spec §9 of
-- docs/superpowers/specs/2026-11-13-products-grid-save-button-design.md; §5
-- is this function).
--
-- Saves every unsaved change on the products grid ("שמור שינויים" on "סידור
-- לפי מוצרים") in ONE transaction, all or nothing: cells (pick line ×
-- customer) given a number for the first time, cells whose number changed,
-- and cells cleared.
--
-- It replaces the grid's auto-save, which wrote each cell the moment it was
-- left; the office wants one button that saves all the changes (James,
-- 2026-11-13). Calling arrange_to_customer and delete_arrangement_record once
-- per cell from the browser would break R4 — a refusal half-way would leave
-- half the day saved — and would overwrite a cell another distributor changed
-- in the meantime: 0075 replaced exactly such a loop for "הצע סידור", for
-- those two reasons. save_arrangement_proposal (0075, 0085) cannot be reused,
-- because it only fills empty cells. Here a refusal anywhere saves nothing.
--
-- Each change says what its cell held when it was changed (`expected`: the
-- record's id and pallets, or no record). A cell that no longer holds that —
-- filled, changed or emptied since — is refused, never overwritten, and the
-- whole save with it, naming every such cell at once (P0006), so the screen
-- can drop those cells' numbers and offer the rest again.
--
-- Each change still goes through the per-cell functions, so their rules live
-- in one place (R6): delete_arrangement_record (0021) clears a cell, and
-- arrange_to_customer (0040, latest 0100) sets one — the backoffice and
-- open-arrangement checks, the zero-pallet order line it creates for a push,
-- and check_arrangement_allocation (0050), whose sums see this transaction's
-- own writes. Its price arguments are left out, so it COALESCEs and a record
-- keeps its own price. The tenths trigger (0085) and the closed-pick trigger
-- (0089) apply unchanged. Clears and decreases are applied first, then
-- increases and new cells, so that moving pallets between two customers on a
-- lot with nothing free is not refused for the moment both would hold them.
--
-- Locks (R7), the trading day first, in 0075's order — the order
-- close_arrangement, discard_business_day and sync_grower_picks take theirs:
--   1. trading_days FOR SHARE, so a save cannot land inside a running
--      close_arrangement, unpriced and missing from the leftovers it computed.
--   2. daily_arrangements FOR UPDATE. Every arrangement-record writer (0021,
--      0040) takes it, so "this cell still holds what was expected" stays true
--      until commit.
--   3. The pick lines touched, FOR SHARE, in id order, so save_pick_lines
--      (0050) cannot lower pallets_picked under the allocation check.
--   4. The order headers of the customers involved, FOR UPDATE, in id order.
--      submit_order changes a customer's lines under that row's lock, so
--      "this customer still has that order" stays true until commit.
--
-- p_changes: [{ "dailyPickProductId": uuid, "customerCompanyId": uuid,
--               "quantityPallets": a number of zero or more, at most one
--                                  decimal place (0 clears the cell),
--               "expected": { "recordId": uuid | null (no record),
--                             "quantityPallets": a number of zero or more,
--                                                at most one decimal place },
--               "forOrder": true | false (optional, as in 0075) }, ...]
-- Returns the number of cells written.
--
-- save_arrangement_proposal stays, so a tab still open on the old app keeps
-- working; nothing new calls it. No Edge Function needs redeploying:
-- whatsapp-dispatch reads nothing this touches. Written to be re-run.

create or replace function public.save_arrangement_changes(
  p_trading_day_id uuid,
  p_changes jsonb
)
returns integer
language plpgsql
-- SECURITY: INVOKER, not definer. ALLOWS the function only the rights its
-- caller already has: every read and write goes through the caller's own
-- RLS, whose backoffice-only write policies on daily_order_products (0017)
-- and arrangement_records (0010) stand behind the role check below.
-- PROTECTS AGAINST the function becoming a way around those policies, as a
-- definer would be: it would write with its owner's rights, whoever called.
security invoker
-- SECURITY: names in the body resolve in public only. PROTECTS AGAINST a
-- caller's search_path pointing a table or function named here at an object
-- of their own.
set search_path = public
as $$
declare
  v_arrangement public.daily_arrangements;
  v_bad jsonb;
  v_record public.arrangement_records;
  v_saved integer := 0;
  v_index bigint;
  v_pick_line_id uuid;
  v_customer_id uuid;
  v_quantity numeric;
  v_expected_record_id uuid;
  v_state text;
  v_message text;
  -- The changes, typed: one entry per change, in the order given.
  v_pick_line_ids uuid[];
  v_customer_ids uuid[];
  v_quantities numeric[];
  v_expected_record_ids uuid[];
  v_expected_quantities numeric[];
  v_for_order boolean[];
begin
  -- SECURITY: ALLOWS backoffice users only. PROTECTS AGAINST customers,
  -- growers and transporters changing the arrangement, and against a
  -- signed-in user with no profile: their role is NULL, and
  -- `NULL <> 'backoffice'` is NULL, not true, so a `<>` check would let them
  -- through — hence `is distinct from`.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception 'INVALID_INPUT: changes must be a JSON array' using errcode = 'P0008';
  end if;

  perform 1 from public.trading_days where id = p_trading_day_id for share;
  if not found then
    raise exception 'NOT_FOUND: trading day % does not exist', p_trading_day_id using errcode = 'P0002';
  end if;

  select * into v_arrangement
  from public.daily_arrangements
  where trading_day_id = p_trading_day_id
  for update;
  if not found then
    raise exception 'NOT_FOUND: no arrangement exists for trading day %', p_trading_day_id using errcode = 'P0002';
  end if;
  if v_arrangement.status <> 'open' then
    raise exception 'INVALID_STATE: the arrangement is closed' using errcode = 'P0007';
  end if;

  -- Every change well formed, before anything is read by it. Postgres does
  -- not promise to evaluate OR from left to right, so every cast sits inside
  -- a CASE that has already checked the value's JSON type.
  select jsonb_agg(e.ord - 1 order by e.ord) into v_bad
  from jsonb_array_elements(p_changes) with ordinality as e(elem, ord)
  where jsonb_typeof(e.elem -> 'dailyPickProductId') is distinct from 'string'
     or jsonb_typeof(e.elem -> 'customerCompanyId') is distinct from 'string'
     or (e.elem ->> 'dailyPickProductId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or (e.elem ->> 'customerCompanyId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     -- The new number: zero or more, at most one decimal place.
     or case
          when jsonb_typeof(e.elem -> 'quantityPallets') = 'number'
            then (e.elem ->> 'quantityPallets')::numeric < 0
              or (e.elem ->> 'quantityPallets')::numeric <> round((e.elem ->> 'quantityPallets')::numeric, 1)
          else true
        end
     -- What the cell held: no record (JSON null) or a record's id, and its
     -- number, as above.
     or case
          when jsonb_typeof(e.elem -> 'expected') = 'object'
            then case jsonb_typeof(e.elem -> 'expected' -> 'recordId')
                   when 'null' then false
                   when 'string'
                     then (e.elem -> 'expected' ->> 'recordId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   else true
                 end
              or case
                   when jsonb_typeof(e.elem -> 'expected' -> 'quantityPallets') = 'number'
                     then (e.elem -> 'expected' ->> 'quantityPallets')::numeric < 0
                       or (e.elem -> 'expected' ->> 'quantityPallets')::numeric
                          <> round((e.elem -> 'expected' ->> 'quantityPallets')::numeric, 1)
                   else true
                 end
          else true
        end
     -- Clearing a cell (0) needs the record it clears.
     or case
          when jsonb_typeof(e.elem -> 'quantityPallets') = 'number'
            then (e.elem ->> 'quantityPallets')::numeric = 0
             and jsonb_typeof(e.elem -> 'expected' -> 'recordId') is distinct from 'string'
          else false
        end
     or (e.elem ? 'forOrder' and jsonb_typeof(e.elem -> 'forOrder') <> 'boolean');
  if v_bad is not null then
    raise exception 'INVALID_INPUT: each change needs a pick line, a customer, a number of pallets of zero or more with at most one decimal place, and what the cell held (expected) — a record to clear when the number is zero'
      using errcode = 'P0008', detail = jsonb_build_object('indexes', v_bad)::text;
  end if;

  -- Read into typed columns ONCE, and every statement below joins on those —
  -- never on an id pulled out of the JSON inside the join. Under RLS Postgres
  -- will not push a condition that calls a function it does not know to be
  -- leakproof (->> and the cast to uuid are not) into the scan of a protected
  -- table, so such a join cannot use the index and reads the whole table for
  -- every cell: 72 cells × 82,000 pick lines took over 10 seconds against
  -- October's data, past a signed-in caller's 8-second statement timeout
  -- (0075).
  select array_agg(a.pick_line_id order by a.ord),
         array_agg(a.customer_id order by a.ord),
         array_agg(a.quantity order by a.ord),
         array_agg((a.expected ->> 'recordId')::uuid order by a.ord),
         array_agg((a.expected ->> 'quantityPallets')::numeric order by a.ord),
         array_agg(coalesce(a.for_order, false) order by a.ord)
    into v_pick_line_ids, v_customer_ids, v_quantities,
         v_expected_record_ids, v_expected_quantities, v_for_order
  from rows from (
         jsonb_to_recordset(p_changes)
           as ("dailyPickProductId" uuid, "customerCompanyId" uuid, "quantityPallets" numeric,
               "expected" jsonb, "forOrder" boolean)
       ) with ordinality as a(pick_line_id, customer_id, quantity, expected, for_order, ord);

  -- One entry per cell: two would both be checked against what the cell held
  -- before either was applied, and the second would silently undo the first.
  select jsonb_agg(jsonb_build_object('dailyPickProductId', d.pick_line_id, 'customerCompanyId', d.customer_id))
    into v_bad
  from (
    select a.pick_line_id, a.customer_id
    from unnest(v_pick_line_ids, v_customer_ids) as a(pick_line_id, customer_id)
    group by 1, 2
    having count(*) > 1
  ) d;
  if v_bad is not null then
    raise exception 'INVALID_INPUT: a cell appears more than once'
      using errcode = 'P0008', detail = jsonb_build_object('cells', v_bad)::text;
  end if;

  select jsonb_agg(distinct a.pick_line_id) into v_bad
  from unnest(v_pick_line_ids) as a(pick_line_id)
  where not exists (
    select 1
    from public.daily_pick_products dpp
    join public.daily_picks dp on dp.id = dpp.daily_pick_id
    where dpp.id = a.pick_line_id
      and dp.trading_day_id = p_trading_day_id
  );
  if v_bad is not null then
    raise exception 'NOT_FOUND: % pick line(s) are not on trading day %', jsonb_array_length(v_bad), p_trading_day_id
      using errcode = 'P0002', detail = jsonb_build_object('pickLineIds', v_bad)::text;
  end if;

  perform 1
  from public.daily_pick_products
  where id = any (v_pick_line_ids)
  order by id
  for share;

  perform 1
  from public.daily_orders
  where trading_day_id = p_trading_day_id
    and customer_company_id = any (v_customer_ids)
  order by id
  for update;

  -- Changed since it was typed over — filled, changed or emptied: the whole
  -- save is refused, naming every such cell at once. A cell's record is found
  -- off its order line's customer, and off the record's own copy of the
  -- customer as well, as the grid reads it (and as 0075 does).
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
  if v_bad is not null then
    raise exception 'CONFLICT: % cell(s) changed since they were typed over', jsonb_array_length(v_bad)
      using errcode = 'P0006', detail = jsonb_build_object('cells', v_bad)::text;
  end if;

  -- Meant for an order that has gone since the number was typed: the whole
  -- save is refused, naming every such cell at once. A clear (0) is not
  -- checked: taking pallets away needs no order.
  select jsonb_agg(jsonb_build_object(
           'index', a.ord - 1,
           'dailyPickProductId', a.pick_line_id,
           'customerCompanyId', a.customer_id) order by a.ord)
    into v_bad
  from unnest(v_pick_line_ids, v_customer_ids, v_quantities, v_for_order) with ordinality
         as a(pick_line_id, customer_id, quantity, for_order, ord)
  join public.daily_pick_products dpp on dpp.id = a.pick_line_id
  where a.for_order
    and a.quantity > 0
    and not exists (
      select 1
      from public.daily_orders o
      join public.daily_order_products dop on dop.daily_order_id = o.id
      where o.trading_day_id = p_trading_day_id
        and o.customer_company_id = a.customer_id
        and dop.product_variety_id = dpp.product_variety_id
        and dop.pallets_ordered > 0
    );
  if v_bad is not null then
    raise exception 'CONFLICT: % cell(s) of these changes are no longer ordered', jsonb_array_length(v_bad)
      using errcode = 'P0006', detail = jsonb_build_object('cells', v_bad)::text;
  end if;

  -- One exception block around the whole loop — one subtransaction, not one
  -- per cell. It only adds WHICH change failed; the SQLSTATE and message are
  -- those of the function or trigger that refused it, so the screen maps them
  -- as it maps a single cell's.
  begin
    for v_index, v_pick_line_id, v_customer_id, v_quantity, v_expected_record_id in
      select a.ord - 1, a.pick_line_id, a.customer_id, a.quantity, a.expected_record_id
      from unnest(v_pick_line_ids, v_customer_ids, v_quantities, v_expected_record_ids, v_expected_quantities)
             with ordinality as a(pick_line_id, customer_id, quantity, expected_record_id, expected_quantity, ord)
      -- Clears and decreases first: moving pallets between two customers on a
      -- full lot must not be refused for the moment both hold them.
      order by case when a.quantity < a.expected_quantity then 0 else 1 end, a.ord
    loop
      if v_quantity = 0 then
        -- The cell's own record: the check above found it there, unchanged.
        perform public.delete_arrangement_record(v_expected_record_id);
      else
        -- Price arguments left out: arrange_to_customer COALESCEs, so the record keeps its own.
        select * into v_record from public.arrange_to_customer(v_pick_line_id, v_customer_id, v_quantity);
        -- arrange_to_customer UPDATES a record it finds. Under the locks above
        -- none can appear in a cell found empty except through a direct write
        -- to the table (0010's backoffice write policy); a record this
        -- transaction did not create is refused rather than overwritten.
        if v_expected_record_id is null and v_record.created_at is distinct from now() then
          raise exception 'CONFLICT: this cell was filled while the changes were being saved' using errcode = 'P0006';
        end if;
      end if;
      v_saved := v_saved + 1;
    end loop;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    raise exception using
      errcode = v_state,
      message = v_message,
      detail = jsonb_build_object(
        'index', v_index,
        'dailyPickProductId', v_pick_line_id,
        'customerCompanyId', v_customer_id,
        'quantityPallets', v_quantity)::text;
  end;

  return v_saved;
end;
$$;

comment on function public.save_arrangement_changes(uuid, jsonb) is
  'Backoffice-only (migration 0103). Saves the products grid''s changes for one trading day in one transaction, all or nothing: a cell set to a number through arrange_to_customer (the record keeps its own price), a cell cleared (0) through delete_arrangement_record, clears and decreases first. Each change says what its cell held when it was changed (expected: the record id and pallets, or no record). Returns the number of cells written. Raises 42501 for a non-backoffice caller; P0002 for an unknown day or arrangement, or a pick line not on that day (DETAIL pickLineIds); P0007 if the arrangement is closed; P0008 for a malformed change (DETAIL indexes) or a repeated cell (DETAIL cells); P0006 if a cell no longer holds what was expected, or was marked forOrder and its order has gone (DETAIL cells lists every such cell); and whatever arrange_to_customer, delete_arrangement_record or the triggers raise (P0002/P0008/P0009/P0010), or P0006 for a cell filled during the save itself, with its SQLSTATE kept and DETAIL naming the change (index, dailyPickProductId, customerCompanyId, quantityPallets).';

-- SECURITY: the revoke. ALLOWS nothing; it takes EXECUTE away from public
-- (Postgres gives every new function to public, which every role inherits)
-- and from anon (Supabase's default privileges grant it to anon directly).
-- PROTECTS AGAINST a visitor who is not signed in reaching the function at
-- all, not even its role check — as in 0055, 0059, 0062, 0074 and 0075.
revoke execute on function public.save_arrangement_changes(uuid, jsonb) from public, anon;

-- SECURITY: the grant. ALLOWS signed-in users (`authenticated`) and the
-- service role to call it. Calling it is not saving: the function refuses
-- everyone but backoffice, and, being SECURITY INVOKER, it (and the per-cell
-- functions it calls) writes through the caller's own RLS, whose
-- backoffice-only write policies on daily_order_products (0017) and
-- arrangement_records (0010) stand behind that refusal. It needs no right the
-- caller lacks, unlike save_pick_lines (0039), which is why it is not a
-- definer. PROTECTS AGAINST, for the backoffice users it lets through: a cell
-- someone else changed being overwritten (refused, never upserted); a cell
-- meant for an order becoming a push once that order is withdrawn (refused);
-- a half-saved day (one transaction); and a save landing inside a running
-- close_arrangement (the trading day is locked first).
grant execute on function public.save_arrangement_changes(uuid, jsonb) to authenticated, service_role;
