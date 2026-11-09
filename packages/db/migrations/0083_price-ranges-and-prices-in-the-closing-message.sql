-- Workbook Tasks 27 and 37.
--
-- Task 27 — James's decision D8 (2026-11-09): a price range is shown as a
-- range, like Bubble ("10 - 12"), not as an invented single price. The shop
-- already shows a product's range (₪10–₪12). What changes is the end of the
-- day: populate_arrangement_prices used to give a record with no price of
-- its own the MIDPOINT of its product's range (0022/0065), and that one number
-- went out in the customer's closing message. Now such a record keeps its
-- price empty and stores the range instead (arrangement_records
-- price_range_from / price_range_to), and the message shows "₪10–₪12". A
-- fixed price, or a price the distributor set on the record, works as before.
-- Days already closed keep the prices they were closed with.
--
-- Task 37 — the closing message lists the customer's prices only when the
-- price rules let that customer see them: the day's shop shows prices AND the
-- customer's company may see prices (companies.can_see_product_prices — the
-- rule 0072 gave the shop; the message used to check only the day). A
-- customer who cannot see prices in the app gets the message without any
-- (decision D19, until the client says otherwise).
--
-- Rollout: nothing to deploy with it. Safe to run again.

-- 1. Where a record keeps its range.
alter table public.arrangement_records
  add column if not exists price_range_from numeric(10, 2),
  add column if not exists price_range_to numeric(10, 2);

comment on column public.arrangement_records.price_range_from is
  'Low end of the price range this record was closed with, when its product had a range and no fixed price (and the record had no price of its own). price is then left empty — a range is shown as a range (D8, migration 0083). Null otherwise.';
comment on column public.arrangement_records.price_range_to is
  'High end of the price range — see price_range_from.';

-- 2. The end-of-day pricing: 0065's populate_arrangement_prices, with the
-- range kept as a range.
create or replace function public.populate_arrangement_prices(p_trading_day_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated integer;
begin
  -- SECURITY: ALLOWS a backoffice account to run this (it runs inside
  -- close_arrangement). PROTECTS AGAINST a grower or customer calling it
  -- through the API and writing prices onto the day's arrangement records,
  -- which only the distributor may set. `is distinct from` (0083, was `<>`)
  -- also refuses a NULL role — no profile, or not signed in; row-level
  -- security on arrangement_records stops them as well.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;
  -- Only a record with no price of its own, whose product has a fixed price
  -- or both ends of a range. A fixed price is copied; a range is copied as
  -- the two ends, and the record's price stays empty.
  update public.arrangement_records ar
  set price = pv.price,
      price_range_from = case when pv.price is null then pv.price_range_from end,
      price_range_to = case when pv.price is null then pv.price_range_to end,
      price_type = coalesce(ar.price_type, pv.price_type),
      updated_at = now()
  from public.daily_pick_products dpp
  join public.daily_picks dp on dp.id = dpp.daily_pick_id
  join public.product_varieties pv on pv.id = dpp.product_variety_id
  where ar.daily_pick_product_id = dpp.id
    and dp.trading_day_id = p_trading_day_id
    and ar.price is null
    and ar.price_range_from is null
    and (
      pv.price is not null
      or (pv.price_range_from is not null and pv.price_range_to is not null)
    );
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.populate_arrangement_prices(uuid) is
  'Backoffice-only. Prices any un-priced arrangement_records row for this trading day: the variety''s fixed price if it has one; otherwise, if it has both ends of a price range, the range is stored on the record (price_range_from / price_range_to) and its price stays empty — a range is never turned into one number (D8, 0083). A row whose variety has neither is left as it is (0065: a missing price never stops the day closing). Returns how many rows it priced.';

-- 3. A line's price in a message: a fixed price as "₪12", a range as
-- "₪10–₪12" (the shop's own way of writing it). Otherwise 0052's text.
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
      line ->> 'quantityPallets',
      coalesce(line ->> 'growerCompanyName', line ->> 'customerCompanyName')
    ),
    chr(10)
    order by line ->> 'familyName', line ->> 'varietyName'
  )
  from jsonb_array_elements(p_payload -> 'lines') as line;
$$;

-- 4. The end of the day: 0081's build_notification_outbox, with the
-- customers' prices following the price rules and carrying ranges. The
-- growers' and transporters' part is 0081's, unchanged.
create or replace function public.build_notification_outbox(p_trading_day_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_can_see_prices boolean;
  v_trade_date date;
  v_customer_count integer;
  v_grower_count integer;
begin
  -- SECURITY: ALLOWS only backoffice staff (it runs inside close_arrangement).
  -- PROTECTS AGAINST anyone else writing WhatsApp messages to every customer,
  -- grower and transporter; `is distinct from` also refuses a NULL role.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select ds.can_see_prices, td.trade_date into v_can_see_prices, v_trade_date
  from public.daily_shops ds
  join public.trading_days td on td.id = ds.trading_day_id
  where ds.trading_day_id = p_trading_day_id;

  -- SECURITY (prices): ALLOWS a customer's closing message to list prices
  -- only when the day's shop shows prices AND the customer's company may see
  -- them (0083 — the rule the shop follows since 0072). PROTECTS AGAINST a
  -- customer the office hides prices from reading them in WhatsApp instead:
  -- for them every line goes out with no price at all.
  insert into public.notification_outbox (trading_day_id, recipient_type, recipient_company_id, template_key, payload)
  select
    p_trading_day_id, 'customer', ar.customer_company_id, 'close_arrangement_customer',
    jsonb_build_object(
      'tradeDate', v_trade_date,
      'canSeePrices', coalesce(v_can_see_prices, false) and coalesce(cc.can_see_product_prices, false),
      'lines', jsonb_agg(jsonb_build_object(
        'familyName', pf.name,
        'varietyName', pv.name,
        'varietySizes', pv.sizes,
        'quantityPallets', ar.quantity_pallets,
        'price', case when v_can_see_prices and cc.can_see_product_prices then ar.price end,
        'priceRangeFrom', case when v_can_see_prices and cc.can_see_product_prices then ar.price_range_from end,
        'priceRangeTo', case when v_can_see_prices and cc.can_see_product_prices then ar.price_range_to end,
        'growerCompanyName', gc.name
      ))
    )
  from public.arrangement_records ar
  join public.companies cc on cc.id = ar.customer_company_id
  join public.daily_order_products dop on dop.id = ar.daily_order_product_id
  join public.daily_orders do2 on do2.id = dop.daily_order_id
  join public.product_varieties pv on pv.id = dop.product_variety_id
  join public.product_families pf on pf.id = pv.family_id
  join public.daily_pick_products dpp on dpp.id = ar.daily_pick_product_id
  join public.daily_picks dp on dp.id = dpp.daily_pick_id
  join public.companies gc on gc.id = dp.grower_company_id
  where do2.trading_day_id = p_trading_day_id
    and ar.quantity_pallets > 0
    and do2.status <> 'open'
  group by ar.customer_company_id, cc.can_see_product_prices;
  get diagnostics v_customer_count = row_count;

  -- Growers (and their transporters) not already messaged when the
  -- distributor completed them with the truck icon (0081).
  select coalesce(sum(public.queue_grower_sale_messages(p_trading_day_id, g.grower_company_id)), 0)
    into v_grower_count
  from (
    select distinct dp.grower_company_id
    from public.arrangement_records ar
    join public.daily_pick_products dpp on dpp.id = ar.daily_pick_product_id
    join public.daily_picks dp on dp.id = dpp.daily_pick_id
    where dp.trading_day_id = p_trading_day_id
      and ar.quantity_pallets > 0
      and dp.completion_messaged_at is null
  ) g;

  return v_customer_count + v_grower_count;
end;
$$;
