-- Workbook Task 35 — orders and arrangements take one decimal place.
--
-- The client asked (4 November) for fractional pallets: an order line or an
-- arrangement may be 0.4 or 2.5 pallets, never 0.14. The columns already
-- keep two decimals (numeric(10,2)), so nothing about storage changes; what
-- changes is what a save may put in them, and how a message writes it:
--
-- 1. A save made through the app (by a signed-in user) is refused when an
--    order line's pallets_ordered or an arrangement's quantity_pallets has a
--    second decimal place. The screens never send one — the same rule is in
--    packages/shared/src/pallets.ts — so this is for a request sent straight
--    to the database. One trigger on each of the two tables, rather than a
--    check restated inside every writer: submit_order, arrange_to_customer,
--    the arrangement-record functions and save_arrangement_proposal are all
--    covered without copying any of them.
-- 2. save_arrangement_proposal (0075) took whole pallets only, so a "הצע
--    סידור" proposal holding 0.4 could not be saved. It now takes one decimal
--    place. Its body is 0075's, with only that check and its message changed.
-- 3. Quantities in a WhatsApp message are written without trailing zeros —
--    "0.4 משטחים", "3 משטחים" — where they used to be the column's own text,
--    "0.40" and "3.00". compose_order_details_text is 0083's otherwise.
--
-- Picks and leftovers are not touched: the screens keep them whole until the
-- client confirms otherwise (decision D18). A leftover can still come out
-- fractional at the end of a day on which 0.4 of a pallet was sold.
--
-- Data already stored is left as it is. The check looks only at a quantity
-- being written, and only when it changes, so an older line can still have
-- its comment edited; and the Bubble importer runs as the database owner, so
-- importing Bubble's history as it is cannot fail on an old quantity. To see
-- how many stored quantities have a second decimal place (read-only):
--   select
--     (select count(*) from public.daily_order_products
--      where pallets_ordered <> round(pallets_ordered, 1)) as order_lines,
--     (select count(*) from public.arrangement_records
--      where quantity_pallets <> round(quantity_pallets, 1)) as arrangements;
--
-- Rollout: run this before pushing the web app that lets a quantity have a
-- decimal place (its "הצע סידור" save needs part 2). The web app deployed
-- today keeps working after it — it only ever sends whole pallets. No Edge
-- Function needs redeploying: the message text is composed in the database.
-- Safe to run again.

-- 1. At most one decimal place on order lines and arrangements.
--
-- SECURITY: a check on saves made through the app. ALLOWS an order line or an
-- arrangement of any number of pallets with at most one decimal place, and
-- any save that leaves the quantity as it was (so a comment can still be
-- edited on an older line). PROTECTS AGAINST a quantity finer than the
-- screens allow being stored by a request sent straight to the API: it would
-- appear on the board and in messages as a number nobody can type, and break
-- the 0.1 steps the board and "הצע סידור" count in. Only saves by a signed-in
-- user are checked (auth.uid() is set): the Bubble importer and migrations
-- run as the database owner, so importing Bubble's history as it is cannot
-- fail. Skipping a missing auth.uid() opens nothing to anonymous callers —
-- they cannot write either table at all (row-level security, and EXECUTE
-- revoked on every function that writes them). Not security definer: it
-- reads nothing but the row being written.
create or replace function public.refuse_pallets_finer_than_tenths()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_new numeric;
  v_old numeric;
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_table_name = 'daily_order_products' then
    v_new := new.pallets_ordered;
    if tg_op = 'UPDATE' then
      v_old := old.pallets_ordered;
    end if;
  else
    v_new := new.quantity_pallets;
    if tg_op = 'UPDATE' then
      v_old := old.quantity_pallets;
    end if;
  end if;
  if tg_op = 'UPDATE' and v_new is not distinct from v_old then
    return new;
  end if;
  if v_new <> round(v_new, 1) then
    raise exception 'INVALID_INPUT: a number of pallets can have at most one decimal place (such as 0.4), not %', v_new
      using errcode = 'P0008';
  end if;
  return new;
end;
$$;

comment on function public.refuse_pallets_finer_than_tenths() is
  'Trigger (0085). Refuses an order line''s pallets_ordered or an arrangement''s quantity_pallets with more than one decimal place (P0008), on saves by a signed-in user, when the quantity changes.';

-- SECURITY: ALLOWS no one to call it directly; it only runs as the two
-- triggers below. PROTECTS AGAINST it being reached as an API function.
revoke execute on function public.refuse_pallets_finer_than_tenths() from public, anon, authenticated, service_role;

drop trigger if exists daily_order_products_pallets_in_tenths on public.daily_order_products;
create trigger daily_order_products_pallets_in_tenths
  before insert or update of pallets_ordered on public.daily_order_products
  for each row
  execute function public.refuse_pallets_finer_than_tenths();

drop trigger if exists arrangement_records_pallets_in_tenths on public.arrangement_records;
create trigger arrangement_records_pallets_in_tenths
  before insert or update of quantity_pallets on public.arrangement_records
  for each row
  execute function public.refuse_pallets_finer_than_tenths();

-- 2. save_arrangement_proposal: one decimal place, not whole pallets only.
-- p_allocations: [{ "dailyPickProductId": uuid, "customerCompanyId": uuid,
--                   "quantityPallets": a number above zero, at most one
--                   decimal place, "forOrder": true | false (optional) }, ...]
create or replace function public.save_arrangement_proposal(
  p_trading_day_id uuid,
  p_allocations jsonb
)
returns integer
language plpgsql
security invoker
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
  v_state text;
  v_message text;
  -- The allocations, typed: one entry per allocation, in the order given.
  v_pick_line_ids uuid[];
  v_customer_ids uuid[];
  v_quantities numeric[];
  v_for_order boolean[];
begin
  -- `is distinct from`, not `<>`: a caller with no profile has a NULL role.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'INVALID_INPUT: allocations must be a JSON array' using errcode = 'P0008';
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

  -- Every allocation well formed, before anything is read by it.
  select jsonb_agg(e.ord - 1 order by e.ord) into v_bad
  from jsonb_array_elements(p_allocations) with ordinality as e(elem, ord)
  where jsonb_typeof(e.elem -> 'dailyPickProductId') is distinct from 'string'
     or jsonb_typeof(e.elem -> 'customerCompanyId') is distinct from 'string'
     or (e.elem ->> 'dailyPickProductId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or (e.elem ->> 'customerCompanyId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or case
          when jsonb_typeof(e.elem -> 'quantityPallets') = 'number'
            then (e.elem ->> 'quantityPallets')::numeric <= 0
              or (e.elem ->> 'quantityPallets')::numeric <> round((e.elem ->> 'quantityPallets')::numeric, 1)
          else true
        end
     or (e.elem ? 'forOrder' and jsonb_typeof(e.elem -> 'forOrder') <> 'boolean');
  if v_bad is not null then
    raise exception 'INVALID_INPUT: each allocation needs a pick line, a customer and a number of pallets above zero with at most one decimal place'
      using errcode = 'P0008', detail = jsonb_build_object('indexes', v_bad)::text;
  end if;

  -- Read into typed columns ONCE, and every statement below joins on those —
  -- never on an id pulled out of the JSON inside the join. Under RLS Postgres
  -- will not push a condition that calls a function it does not know to be
  -- leakproof (->> and the cast to uuid are not) into the scan of a protected
  -- table, so such a join cannot use the index and reads the whole table for
  -- every cell: 72 cells × 82,000 pick lines took over 10 seconds against
  -- October's data, past a signed-in caller's 8-second statement timeout.
  select array_agg(a.pick_line_id order by a.ord),
         array_agg(a.customer_id order by a.ord),
         array_agg(a.quantity order by a.ord),
         array_agg(coalesce(a.for_order, false) order by a.ord)
    into v_pick_line_ids, v_customer_ids, v_quantities, v_for_order
  from rows from (
         jsonb_to_recordset(p_allocations)
           as ("dailyPickProductId" uuid, "customerCompanyId" uuid, "quantityPallets" numeric, "forOrder" boolean)
       ) with ordinality as a(pick_line_id, customer_id, quantity, for_order, ord);

  -- One entry per cell: a second would find the first's record and read as a
  -- conflict with itself.
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

  -- Meant for an order that has gone since the proposal was read: the whole
  -- save is refused, naming every such cell at once.
  select jsonb_agg(jsonb_build_object(
           'index', a.ord - 1,
           'dailyPickProductId', a.pick_line_id,
           'customerCompanyId', a.customer_id) order by a.ord)
    into v_bad
  from unnest(v_pick_line_ids, v_customer_ids, v_for_order) with ordinality
         as a(pick_line_id, customer_id, for_order, ord)
  join public.daily_pick_products dpp on dpp.id = a.pick_line_id
  where a.for_order
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
    raise exception 'CONFLICT: % cell(s) of this proposal are no longer ordered', jsonb_array_length(v_bad)
      using errcode = 'P0006', detail = jsonb_build_object('cells', v_bad)::text;
  end if;

  -- Filled since the proposal was read: the whole save is refused, naming
  -- every such cell at once. A cell's customer is read off its order line,
  -- and off the record's own copy as well, as the grid reads it.
  select jsonb_agg(jsonb_build_object(
           'index', a.ord - 1,
           'dailyPickProductId', a.pick_line_id,
           'customerCompanyId', a.customer_id) order by a.ord)
    into v_bad
  from unnest(v_pick_line_ids, v_customer_ids) with ordinality as a(pick_line_id, customer_id, ord)
  where exists (
    select 1
    from public.arrangement_records ar
    left join public.daily_order_products dop on dop.id = ar.daily_order_product_id
    left join public.daily_orders o on o.id = dop.daily_order_id
    where ar.daily_pick_product_id = a.pick_line_id
      and (o.customer_company_id = a.customer_id or ar.customer_company_id = a.customer_id)
  );
  if v_bad is not null then
    raise exception 'CONFLICT: % cell(s) of this proposal were filled after it was read', jsonb_array_length(v_bad)
      using errcode = 'P0006', detail = jsonb_build_object('cells', v_bad)::text;
  end if;

  -- One exception block around the whole loop — one subtransaction, not one
  -- per cell. It only adds WHICH allocation failed; the SQLSTATE and message
  -- are arrange_to_customer's own, so the screen maps them as it maps a
  -- single cell's.
  begin
    for v_index, v_pick_line_id, v_customer_id, v_quantity in
      select a.ord - 1, a.pick_line_id, a.customer_id, a.quantity
      from unnest(v_pick_line_ids, v_customer_ids, v_quantities) with ordinality
             as a(pick_line_id, customer_id, quantity, ord)
      order by a.ord
    loop
      select * into v_record
      from public.arrange_to_customer(v_pick_line_id, v_customer_id, v_quantity);
      -- arrange_to_customer UPDATES a record it finds. Under the locks above
      -- none can appear except through a direct write to the table (0010's
      -- backoffice write policy); a record this transaction did not create is
      -- refused rather than overwritten.
      if v_record.created_at is distinct from now() then
        raise exception 'CONFLICT: this cell was filled while the proposal was being saved' using errcode = 'P0006';
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

comment on function public.save_arrangement_proposal(uuid, jsonb) is
  'Backoffice-only. Saves a whole arrangement proposal for one trading day in one transaction, all or nothing, through arrange_to_customer per allocation, and only into cells (pick line × customer) with no arrangement record yet. Returns the number of records created. Raises 42501 for a non-backoffice caller; P0002 for an unknown day or arrangement, or a pick line not on that day; P0007 if the arrangement is closed; P0008 for a malformed or repeated allocation; P0006 if a cell is already filled, or was marked forOrder and its order has gone (DETAIL lists every such cell); and whatever arrange_to_customer raises (P0002/P0008/P0009) with its SQLSTATE kept and DETAIL naming the allocation (index, dailyPickProductId, customerCompanyId, quantityPallets).';

-- SECURITY: ALLOWS signed-in users (`authenticated`) and the service role to
-- call it — the function itself then refuses everyone but backoffice, and
-- being SECURITY INVOKER it (and the arrange_to_customer it calls) writes
-- through the caller's own RLS, whose backoffice-only write policies on
-- daily_order_products (0017) and arrangement_records (0010) stand behind
-- that refusal. It needs no right the caller lacks, unlike save_pick_lines
-- (0039), which is why it is not a definer.
-- PROTECTS AGAINST anonymous callers reaching it at all (EXECUTE revoked from
-- public and anon, as in 0055, 0059, 0062 and 0067); a cell someone else
-- filled being overwritten (refused, never upserted); a cell meant for an
-- order becoming a push once that order is withdrawn (refused); a half-saved
-- day (one transaction); and a save landing inside a running close_arrangement
-- (the trading day is locked first).
revoke execute on function public.save_arrangement_proposal(uuid, jsonb) from public, anon;
grant execute on function public.save_arrangement_proposal(uuid, jsonb) to authenticated, service_role;

-- 3. A message's quantities without trailing zeros.
create or replace function public.compose_order_details_text(p_payload jsonb)
returns text
language sql
immutable
as $$
  select string_agg(
    format(
      '%s — %s%s%s: %s משטחים (%s)',
      line ->> 'familyName',
      line ->> 'varietyName',
      case when coalesce(line ->> 'varietySizes', '') <> '' then format(' %s', line ->> 'varietySizes') else '' end,
      case
        when line ->> 'price' is not null then format(' — ₪%s', line ->> 'price')
        when line ->> 'priceRangeFrom' is not null and line ->> 'priceRangeTo' is not null
          then format(' — ₪%s–₪%s', line ->> 'priceRangeFrom', line ->> 'priceRangeTo')
        else ''
      end,
      trim_scale((line ->> 'quantityPallets')::numeric),
      coalesce(line ->> 'growerCompanyName', line ->> 'customerCompanyName')
    ),
    chr(10)
    order by line ->> 'familyName', line ->> 'varietyName'
  )
  from jsonb_array_elements(p_payload -> 'lines') as line;
$$;

