-- The price each order line was saved at (James, 2026-11-12): a record for
-- later use. No screen shows it.
--
-- daily_order_products gets Bubble's four price fields — price,
-- price_range_from, price_range_to and price_type, typed as on
-- product_varieties — and submit_order fills them, inside the database,
-- from the product at the moment the order is saved. Bubble's order lines
-- have kept the same record since 2026-09-08 ("price type", "price value
-- (fixed)", "price value (range)"; the importer skips them). By the
-- product's price type, as the shop shows a price (0100):
--   - מספר (fixed): the type and the price;
--   - טווח (range): the type and both ends of the range;
--   - every תקליט type: the type alone — it has no number;
--   - no type: what its numbers say, as the shop reads it — a price is
--     מספר, both ends of a range טווח — and otherwise nothing.
--
-- Recorded only when the order's customer may see prices: their company's
-- "can see product prices" AND the day's shop showing prices — the test the
-- shop uses before it shows a customer a price (0072). When staff save an
-- order on a customer's behalf, the customer's permission is the one that
-- counts. Every send records every line it writes again, untouched lines
-- included (James chose this over keeping each line's first price), so a
-- line holds the price of its last save. A send that may not see prices
-- records nothing and clears nothing.
--
-- Nothing the browser sends is trusted for this: the price is read from
-- product_varieties here, and the web app does not change — submit_order
-- keeps 0093's arguments, so every copy of the order screen keeps working,
-- and its permissions stay as they are (CREATE OR REPLACE with the same
-- arguments keeps a function's grants).
--
-- Lines saved before this migration have no record; nothing is backfilled.
--
-- submit_order is 0093's body verbatim apart from the lines marked "0101".
-- Run it in any order with the web deploy. Safe to run again.

-- 1. The columns. Empty until a send records a price.
alter table public.daily_order_products
  add column if not exists price numeric(10, 2),
  add column if not exists price_range_from numeric(10, 2),
  add column if not exists price_range_to numeric(10, 2),
  add column if not exists price_type public.price_type;

comment on column public.daily_order_products.price is
  'The product''s price (מספר) when this line was last saved by a customer who may see prices — written by submit_order only for a fixed price type. Migration 0101.';
comment on column public.daily_order_products.price_range_from is
  'The low end of the product''s price range (טווח) when this line was last saved by a customer who may see prices — written by submit_order only for a range price type. Migration 0101.';
comment on column public.daily_order_products.price_range_to is
  'The high end of the product''s price range (טווח) when this line was last saved by a customer who may see prices — written by submit_order only for a range price type. Migration 0101.';
comment on column public.daily_order_products.price_type is
  'The product''s price type when this line was last saved by a customer who may see prices (a תקליט type is recorded alone, with no number). NULL until such a save, and when the product had neither a type nor a number to read one from. Written by submit_order. Migration 0101.';

-- 2. submit_order, recording each line's price.
create or replace function public.submit_order(
  p_trading_day_id uuid,
  p_lines jsonb,
  p_customer_company_id uuid default null,
  p_comment text default null
)
returns public.daily_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.daily_orders;
  v_phase public.trading_day_phase;
  v_trade_date date;
  v_line jsonb;
  v_kept_ids uuid[] := '{}';
  v_line_id uuid;
  v_pallets numeric;
  v_comment text;
  v_variety_id uuid;
  v_customer_company_id uuid;
  v_customer_company_name text;
  v_direct_customer_submission boolean;
  v_touched_variety_ids uuid[];
  v_demand_before_snapshot jsonb;
  v_demand_before numeric;
  v_demand_after numeric;
  v_supply numeric;
  v_overbooking numeric;
  v_product_name text;
  v_remaining numeric;
  v_max_orderable numeric;
  v_saved_pallets numeric;
  v_blocked_variety_ids uuid[] := '{}';
  -- 0101: the price a line records — see PRICE RECORD below.
  v_sees_prices boolean;
  v_price_type public.price_type;
  v_price numeric;
  v_price_range_from numeric;
  v_price_range_to numeric;
begin
  v_direct_customer_submission := p_customer_company_id is null and public.current_role() = 'customer';

  -- SECURITY: ALLOWS a customer to send their own company's order, and a
  -- backoffice account to send any customer's order on their behalf ("בשם
  -- לקוח"). PROTECTS AGAINST a customer or grower writing another company's
  -- order, a grower ordering at all, and (0076) a signed-in account with no
  -- profile or a caller who is not signed in at all. Those two have a NULL
  -- role. Until 0076 both checks used `<>`, which is never true for NULL, so
  -- neither raised for them — and a send naming another company
  -- (p_customer_company_id) went straight through and was written. They now
  -- use `is distinct from`, which counts NULL as a mismatch and refuses.
  if p_customer_company_id is not null then
    if public.current_role() is distinct from 'backoffice' then
      raise exception 'FORBIDDEN: only backoffice may submit an order on another company''s behalf' using errcode = '42501';
    end if;
    v_customer_company_id := p_customer_company_id;
  else
    if public.current_role() is distinct from 'customer' then
      raise exception 'FORBIDDEN: customer role required' using errcode = '42501';
    end if;
    v_customer_company_id := public.current_company_id();
  end if;

  -- 0071: `for share` — read the day's phase and keep it from changing until
  -- this send is done. ALLOWS any number of order sends at once (shared locks
  -- don't block each other). PROTECTS AGAINST a send and a phase change
  -- crossing: open_shop, close_shop and close_arrangement all start by
  -- locking this same row `for update`, so a send that arrives while the
  -- shop is closing waits for the close to finish and then sees the new
  -- phase, and a close that arrives during a send waits for the send. They
  -- lock nothing before this row, so the two can never wait on each other in
  -- a circle.
  select phase, trade_date into v_phase, v_trade_date from public.trading_days where id = p_trading_day_id for share;
  if not found then
    raise exception 'NOT_FOUND: trading day % does not exist', p_trading_day_id using errcode = 'P0002';
  end if;
  if v_phase = 'closed' then
    raise exception 'INVALID_STATE: cannot submit an order once the trading day is closed' using errcode = 'P0007';
  end if;

  -- 0071: SHOP HOURS — ALLOWS a customer to send their own order only while
  -- the shop is open (phase shop_open). PROTECTS AGAINST an order changing
  -- after close_shop, while the distributor is already arranging from the
  -- numbers — the order screen checks this before sending, but a send in the
  -- moment of closing, from a screen that missed the close, or straight
  -- through the API, used to be accepted until the whole day closed. Staff
  -- ordering on a customer's behalf ("בשם לקוח") are not limited by this:
  -- they may still adjust orders while arranging, up to the day's close (the
  -- check above).
  if v_direct_customer_submission and v_phase <> 'shop_open' then
    raise exception 'INVALID_STATE: the shop is closed for orders' using errcode = 'P0007';
  end if;

  select * into v_order
  from public.daily_orders
  where trading_day_id = p_trading_day_id
    and customer_company_id = v_customer_company_id
  for update;

  if not found then
    raise exception 'NOT_FOUND: no daily order exists for this company on this trading day' using errcode = 'P0002';
  end if;

  -- 0068: STOCK — one order send at a time for each trading day.
  -- ALLOWS every send to go through exactly as before, only in turn.
  -- PROTECTS AGAINST two customers taking the same last pallets. Each send
  -- checks how much is still free (max_orderable_for_customer, below) against
  -- what OTHER customers have already ordered; without this, two sends running
  -- at the same moment each read the stock before the other had saved, both
  -- passed, and together ordered more than exists (reproduced on Postgres 17:
  -- 7 + 7 accepted against 10). Now the second send waits — milliseconds —
  -- for the first to finish, then sees its order. Taken only here, once the
  -- caller is known to have an order for this day, so a call that is refused
  -- above (anonymous, no profile, wrong role, no order) never holds anyone up.
  -- A transaction-level advisory lock: released by itself when this send
  -- commits or fails, and taken nowhere else in the database. Every send locks
  -- its own order row (just above) before this, and touches no other order,
  -- so two sends can never wait on each other in a circle. Backoffice sends
  -- take it too: their pallets count against what customers may still order.
  perform pg_advisory_xact_lock(hashtextextended('submit_order:' || p_trading_day_id::text, 0));

  -- 0072: BLOCKED PRODUCTS. SECURITY: on a customer's own send, ALLOWS
  -- changes only to lines for products that are not on their own blocked
  -- list; a line for a blocked product is left exactly as it is — not
  -- added, not changed, not removed. It PROTECTS AGAINST a customer ordering
  -- a product blocked for them by calling this directly (their order screen
  -- no longer shows one — get_orderable_catalog_for_customer, above), and
  -- against their save deleting a colleague's or the distributor's line for
  -- that product: they are never shown it, so it is never in what they send,
  -- and the prune below would otherwise take every line it is not sent.
  -- Ignored rather than refused, so a screen opened before the block was set
  -- can still save everything else. Staff sending on a customer's behalf are
  -- not affected (Bubble's list, too, applied only to the customer's own
  -- shop).
  if v_direct_customer_submission then
    select coalesce(array_agg(b.product_variety_id), '{}')
    into v_blocked_variety_ids
    from public.profile_blocked_products b
    where b.user_id = (select auth.uid());
  end if;

  -- 0101: PRICE RECORD. Every line this send writes records the product's
  -- price as the order's customer is shown it right now — its price type,
  -- and the price (מספר) or the range (טווח) that type shows; a תקליט type
  -- records the type alone. Recorded again on every send, a line the
  -- customer did not touch included (James, 2026-11-12: "every time the user
  -- submits an order"), so a line holds the price of its last save. Kept for
  -- the record: no screen shows it.
  --
  -- SECURITY: ALLOWS a line to record a price only when the order's customer
  -- may see it today — their company's can_see_product_prices AND the day's
  -- shop can_see_prices, the same test get_orderable_catalog_for_customer
  -- applies before it shows a customer a price (0072). On a staff send made
  -- on a customer's behalf it is still the customer's permission that
  -- counts, never staff's own (Bubble did the same). PROTECTS AGAINST a
  -- customer reading a price hidden from them: customers can read their own
  -- order lines straight from the API (daily_order_products_select_own), so
  -- a price recorded for a company without the permission, or on a day the
  -- shop hides prices, would hand them what 0056 and 0072 keep from them. A
  -- send that may not see prices records nothing and clears nothing: a line
  -- keeps whatever an earlier send recorded. Customers cannot write these
  -- columns themselves — they have no write policy on daily_order_products —
  -- so a record only ever comes from here (running as the function's owner)
  -- or from staff. A permission never set counts as "may not", and so does a
  -- day with no shop.
  select coalesce(c.can_see_product_prices, false) and coalesce(ds.can_see_prices, false)
  into v_sees_prices
  from public.companies c
  left join public.daily_shops ds on ds.trading_day_id = p_trading_day_id
  where c.id = v_customer_company_id;
  v_sees_prices := coalesce(v_sees_prices, false);

  -- Snapshot demand-before for every variety this call could possibly
  -- push across a threshold, BEFORE the upsert loop touches anything.
  select array_agg(distinct (line ->> 'productVarietyId')::uuid)
  into v_touched_variety_ids
  from jsonb_array_elements(p_lines) as line
  where (line ->> 'palletsOrdered')::numeric > 0;

  select jsonb_object_agg(v.variety_id::text, coalesce(d.total, 0))
  into v_demand_before_snapshot
  from unnest(coalesce(v_touched_variety_ids, '{}'::uuid[])) as v(variety_id)
  left join lateral (
    select sum(dop.pallets_ordered) as total
    from public.daily_order_products dop
    join public.daily_orders do2 on do2.id = dop.daily_order_id
    where do2.trading_day_id = p_trading_day_id
      and dop.product_variety_id = v.variety_id
  ) d on true;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_pallets := (v_line ->> 'palletsOrdered')::numeric;
    v_comment := nullif(v_line ->> 'comment', '');
    v_variety_id := (v_line ->> 'productVarietyId')::uuid;

    if v_pallets < 0 then
      raise exception 'INVALID_INPUT: pallets ordered cannot be negative' using errcode = 'P0008';
    end if;

    if v_pallets = 0 then
      continue;
    end if;

    -- 0072: a product blocked for this customer — see BLOCKED PRODUCTS above.
    if v_variety_id = any (v_blocked_variety_ids) then
      continue;
    end if;

    if not exists (
      select 1 from public.daily_pick_products dpp
      join public.daily_picks dp on dp.id = dpp.daily_pick_id
      where dp.trading_day_id = p_trading_day_id
        and dpp.product_variety_id = v_variety_id
    ) then
      raise exception 'INVALID_INPUT: product variety % is not in today''s shop', v_variety_id using errcode = 'P0008';
    end if;

    -- The dropdown's own ceiling, re-checked server-side so a direct API
    -- call can't exceed what the UI offered — never applied to the
    -- backoffice on-behalf-of path, where staff may deliberately override
    -- it (see max_orderable_for_customer's comment).
    --
    -- 0068: and only to a line that goes UP. A quantity the customer already
    -- has saved stays theirs when stock later drops below it: re-sending the
    -- order with that line untouched, or lowering it, is accepted, and only
    -- an increase is held to the limit. The order screen's dropdown already
    -- keeps the saved number on offer for exactly this case (see
    -- dropdownOptions in apps/web/src/components/customer/order-product-list.tsx),
    -- as Bubble's did; until now the server then refused the whole send
    -- because of it, losing every other change the customer had made.
    if v_direct_customer_submission then
      select pallets_ordered into v_saved_pallets
      from public.daily_order_products
      where daily_order_id = v_order.id and product_variety_id = v_variety_id;

      if v_pallets > coalesce(v_saved_pallets, 0) then
        v_max_orderable := public.max_orderable_for_customer(p_trading_day_id, v_variety_id, v_customer_company_id);
        if v_pallets > v_max_orderable then
          raise exception 'INVALID_INPUT: % pallets requested exceeds the % pallet limit available for this product', v_pallets, v_max_orderable
            using errcode = 'P0008';
        end if;
      end if;
    end if;

    -- 0101: the price this line records (PRICE RECORD above), read the way
    -- the shop shows it (formatPriceByType, packages/shared/src/price-type.ts):
    -- the product's own type — or, with none, what its numbers say: a price
    -- is מספר, both ends of a range טווח — and only the numbers that type
    -- shows. A number the type hides (a price left on a טווח product) is
    -- never recorded.
    v_price_type := null;
    v_price := null;
    v_price_range_from := null;
    v_price_range_to := null;
    if v_sees_prices then
      select
        coalesce(pv.price_type, case
          when pv.price is not null then 'fixed'::public.price_type
          when pv.price_range_from is not null and pv.price_range_to is not null then 'range'::public.price_type
        end),
        pv.price,
        pv.price_range_from,
        pv.price_range_to
      into v_price_type, v_price, v_price_range_from, v_price_range_to
      from public.product_varieties pv
      where pv.id = v_variety_id;

      v_price := case when v_price_type = 'fixed' then v_price end;
      v_price_range_from := case when v_price_type = 'range' then v_price_range_from end;
      v_price_range_to := case when v_price_type = 'range' then v_price_range_to end;
    end if;

    insert into public.daily_order_products (
      daily_order_id, product_variety_id, pallets_ordered, comment,
      price_type, price, price_range_from, price_range_to
    )
    values (
      v_order.id, v_variety_id, v_pallets, v_comment,
      v_price_type, v_price, v_price_range_from, v_price_range_to
    )
    on conflict (daily_order_id, product_variety_id)
    do update set pallets_ordered = excluded.pallets_ordered, comment = excluded.comment,
      -- 0101: a send that may see prices records the price again; one that
      -- may not leaves the line's record as it was.
      price_type = case when v_sees_prices then excluded.price_type else daily_order_products.price_type end,
      price = case when v_sees_prices then excluded.price else daily_order_products.price end,
      price_range_from = case when v_sees_prices then excluded.price_range_from else daily_order_products.price_range_from end,
      price_range_to = case when v_sees_prices then excluded.price_range_to else daily_order_products.price_range_to end,
      updated_at = now()
    returning id into v_line_id;

    v_kept_ids := v_kept_ids || v_line_id;
  end loop;

  -- Prune, but never destroy an allocation.
  --
  -- This used to be a bare DELETE of every line not present in p_lines,
  -- and arrangement_records.daily_order_product_id is ON DELETE CASCADE —
  -- so re-saving an order silently deleted the distributor's arrangement
  -- records for any line it dropped. That was already true for ordinary
  -- lines; it becomes a certainty with the zero-quantity lines
  -- arrange_to_customer creates, because submit_order skips zero-pallet
  -- lines entirely (see the `continue` above) and therefore never keeps
  -- one.
  --
  -- A line that something is arranged against is zeroed instead: the
  -- customer's request really is gone, which is what pallets_ordered = 0
  -- now means, but the pallets already committed to them stay visible on
  -- the arrangement board for the distributor to settle deliberately.
  --
  -- 0072: neither touches a line for a product blocked for this customer
  -- (v_blocked_variety_ids is empty for every other caller) — see BLOCKED
  -- PRODUCTS above.
  --
  -- 0101: a zeroed line keeps its price record — the price of its last save.
  update public.daily_order_products
  set pallets_ordered = 0, comment = null, updated_at = now()
  where daily_order_id = v_order.id
    and not (id = any (v_kept_ids))
    and not (product_variety_id = any (v_blocked_variety_ids))
    and exists (
      select 1 from public.arrangement_records ar
      where ar.daily_order_product_id = daily_order_products.id
    );

  delete from public.daily_order_products
  where daily_order_id = v_order.id
    and not (id = any (v_kept_ids))
    and not (product_variety_id = any (v_blocked_variety_ids))
    and not exists (
      select 1 from public.arrangement_records ar
      where ar.daily_order_product_id = daily_order_products.id
    );

  update public.daily_orders
  set status = 'submitted', submitted_at = now(), updated_at = now(),
      -- 0093: the order comment ("הערה כללית"). Not sent keeps the stored
      -- comment (an older copy of the order screen doesn't know the input);
      -- empty text clears it; other text is saved trimmed.
      comment = case when p_comment is null then comment else nullif(btrim(p_comment), '') end
  where id = v_order.id
  returning * into v_order;

  insert into public.order_submission_logs (daily_order_id, submitted_by, snapshot)
  values (v_order.id, (select auth.uid()), p_lines);

  -- id 6.
  if v_direct_customer_submission then
    select name into v_customer_company_name from public.companies where id = v_customer_company_id;
    perform public.enqueue_backoffice_notification(
      p_trading_day_id, 'order_submitted',
      jsonb_build_object('tradeDate', v_trade_date, 'lines', '[]'::jsonb, 'companyName', v_customer_company_name)
    );
  end if;

  -- ids 10/11.
  if v_touched_variety_ids is not null then
    foreach v_variety_id in array v_touched_variety_ids
    loop
      v_demand_before := coalesce((v_demand_before_snapshot ->> v_variety_id::text)::numeric, 0);

      select coalesce(sum(dop.pallets_ordered), 0) into v_demand_after
      from public.daily_order_products dop
      join public.daily_orders do2 on do2.id = dop.daily_order_id
      where do2.trading_day_id = p_trading_day_id
        and dop.product_variety_id = v_variety_id;

      select coalesce(sum(dpp.pallets_picked), 0) + coalesce(sum(dpp.leftover_pallets), 0) into v_supply
      from public.daily_pick_products dpp
      join public.daily_picks dp on dp.id = dpp.daily_pick_id
      where dp.trading_day_id = p_trading_day_id
        and dpp.product_variety_id = v_variety_id;

      select coalesce(no_overbooking, 0), name into v_overbooking, v_product_name
      from public.product_varieties where id = v_variety_id;

      if v_demand_before < v_supply and v_demand_after >= v_supply and v_demand_after < (v_supply + v_overbooking) then
        v_remaining := (v_supply + v_overbooking) - v_demand_after;
        perform public.enqueue_backoffice_notification(
          p_trading_day_id, 'stock_overbooking_reached',
          jsonb_build_object(
            'tradeDate', v_trade_date, 'lines', '[]'::jsonb,
            'productName', v_product_name,
            'productOverbooking', regexp_replace(v_remaining::text, '\.?0+$', '')
          )
        );
      elsif v_demand_before < (v_supply + v_overbooking) and v_demand_after >= (v_supply + v_overbooking) then
        perform public.enqueue_backoffice_notification(
          p_trading_day_id, 'stock_fully_exhausted',
          jsonb_build_object('tradeDate', v_trade_date, 'lines', '[]'::jsonb, 'productName', v_product_name)
        );
      end if;
    end loop;
  end if;

  return v_order;
end;
$$;

comment on function public.submit_order(uuid, jsonb, uuid, text) is
  'Customer-only for their own company (p_customer_company_id omitted). Backoffice-only when p_customer_company_id is supplied. One transaction: upserts-and-prunes daily_order_products from p_lines, sets the order to submitted and stamps submitted_at, writes one order_submission_logs row (attributed to whoever actually called this), and — only on a direct customer submission, never the backoffice-on-behalf-of path — enqueues one order_submitted notification to backoffice (id 6) and rejects (P0008) any line raised above max_orderable_for_customer() for that variety (a line kept at, or lowered from, its saved quantity is accepted even when stock has since dropped below it — migration 0068). On a direct customer submission, a line for a product on the calling user''s own blocked list (profile_blocked_products) is ignored if sent and never pruned: it is left exactly as it was (migration 0072). Also computes, for every variety this call''s lines could have pushed across a threshold, whether it just became fully-ordered-with-overbooking-room (stock_overbooking_reached, id 10) or fully-exhausted (stock_fully_exhausted, id 11) — live, in this same transaction, never via a stored out-of-stock list or trigger. A pruned line that an arrangement_records row points at is zeroed rather than deleted, so re-saving an order can no longer cascade away the distributor''s allocations. Sends for one trading day run one at a time (a transaction-level advisory lock, 0068), so two customers can never both take the same last pallets. Raises P0007 if the trading day is closed, or — for a customer''s own order — if the shop is not open (phase shop_open; migration 0071, which also reads the phase `for share` so a send and close_shop can never cross), P0008 if a line references a variety not in today''s shop, has a negative pallet count, or (direct customer submissions only) raises a line above the per-customer cap. p_comment (0093): the order-level comment (הערה כללית) — null keeps the stored comment, empty text clears it, other text is saved trimmed; it is written under the same checks as the lines and is not part of the submission log snapshot. Price record (0101): every line a send writes records the product''s price as the order''s customer is shown it — price_type, plus price for fixed (מספר) or price_range_from/price_range_to for range (טווח), the type alone for a record_* (תקליט) type; with no type, a price reads as fixed and both ends of a range as range — but only when that customer''s company has can_see_product_prices and the day''s shop can_see_prices (on a staff send on their behalf too). It is recorded again on every such send, untouched lines included; a send that may not see prices records nothing and clears nothing. A zeroed or blocked line keeps its record.';
