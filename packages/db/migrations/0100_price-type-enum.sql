-- Price types are a closed list (James, 2026-11-12): Bubble's "Price
-- Types" option set, in its order:
--   תקליט, תקליט - ₪0.5, תקליט - ₪1, תקליט - ₪1.5, תקליט - ₪2,
--   תקליט + ₪0.5, תקליט + ₪1, תקליט + ₪1.5, תקליט + ₪2, מספר, טווח.
-- product_varieties.price_type and arrangement_records.price_type were free
-- text (0005, 0020: the PRD gave no list); they are now public.price_type,
-- stored as codes (record, record_minus_0_5 … record_plus_2, fixed, range).
-- The screens show Bubble's captions (packages/shared/src/price-type.ts).
--
-- The type decides which price is shown, as in Bubble (its products table:
-- "range" shows from - to, "fixed_price" the price, any other type its
-- name): מספר shows the price, טווח the range from–to, and a תקליט type
-- ("the market's recorded price, plus or minus") its own name, with no
-- number. This migration brings the end of the day into line:
-- populate_arrangement_prices prices a record by its type, and the
-- customer's closing message names a תקליט type where a number would be.
-- The shop and the screens follow the same rule in apps/web.
--
-- The stored values become types as follows:
--   - a code stays itself; a Bubble caption becomes its type. The live
--     project holds exactly Bubble's captions (checked 2026-11-12: מספר 606
--     products, תקליט 25, טווח 1, תקליט ± ₪ 9; records: מספר 9);
--   - anything else, and no value, becomes what its numbers say: a price
--     makes it מספר, both ends of a range טווח, nothing no type at all.
--     Records priced before there were types (5,479 on the live project)
--     become מספר, which is how they were shown.
-- No number is changed or removed. A number the type now hides (a price
-- left on a תקליט product) stays stored, unseen, as in Bubble.
--
-- The functions that write the column take the type as text, as before, so
-- their signatures and grants stay; they now refuse a value that is not one
-- of the codes (22P02). get_orderable_catalog_for_customer returns the code
-- as text.
--
-- Rollout: apply before the web build that sends codes goes live, or soon
-- after it — that build also reads Bubble's captions, so either order works.
-- Safe to run again.

-- 1. The type.
do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'price_type'
  ) then
    create type public.price_type as enum (
      'record',
      'record_minus_0_5',
      'record_minus_1',
      'record_minus_1_5',
      'record_minus_2',
      'record_plus_0_5',
      'record_plus_1',
      'record_plus_1_5',
      'record_plus_2',
      'fixed',
      'range'
    );
  end if;
end;
$$;

comment on type public.price_type is
  'A product''s price type — Bubble''s "Price Types" option set, in its order (migration 0100). fixed (מספר) shows the price, range (טווח) the range from–to, every record_* type (תקליט, תקליט ± ₪…) its own name and no number. Hebrew names: public.price_type_label.';

-- 2. Each type's name, as people read it — Bubble's captions, and
-- PRICE_TYPE_LABELS in packages/shared/src/price-type.ts. The closing
-- message uses it. Takes text so it can read a message's JSON; anything that
-- is not a code has no name (null). It reads no table, so like
-- compose_order_details_text it keeps the default grants.
create or replace function public.price_type_label(p_price_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_price_type
    when 'record' then 'תקליט'
    when 'record_minus_0_5' then 'תקליט - ₪0.5'
    when 'record_minus_1' then 'תקליט - ₪1'
    when 'record_minus_1_5' then 'תקליט - ₪1.5'
    when 'record_minus_2' then 'תקליט - ₪2'
    when 'record_plus_0_5' then 'תקליט + ₪0.5'
    when 'record_plus_1' then 'תקליט + ₪1'
    when 'record_plus_1_5' then 'תקליט + ₪1.5'
    when 'record_plus_2' then 'תקליט + ₪2'
    when 'fixed' then 'מספר'
    when 'range' then 'טווח'
  end;
$$;

comment on function public.price_type_label(text) is
  'The Hebrew name of a price type code (Bubble''s caption: תקליט + ₪1, מספר, טווח …), or null for anything else. Migration 0100.';

-- 3. The stored text as a type, for step 4 only (dropped at the end): a
-- code as itself, a Bubble caption (compared without spacing, shekel sign
-- or kind of minus) as its type, anything else by its numbers.
create or replace function public.price_type_from_text_0100(
  p_price_type text,
  p_price numeric,
  p_price_range_from numeric,
  p_price_range_to numeric
)
returns public.price_type
language plpgsql
immutable
set search_path = public
as $$
declare
  v_key text := btrim(coalesce(p_price_type, ''));
begin
  if v_key = any (enum_range(null::public.price_type)::text[]) then
    return v_key::public.price_type;
  end if;

  v_key := regexp_replace(v_key, 'ש["״]?ח', '', 'g');
  v_key := regexp_replace(v_key, '[₪[:space:]]', '', 'g');
  v_key := translate(v_key, '‐‑‒–—−', '------');
  v_key := regexp_replace(v_key, '(\.[0-9]*[1-9])0+$', '\1');
  v_key := regexp_replace(v_key, '\.0+$', '');
  v_key := case v_key
      when 'תקליט' then 'record'
      when 'תקליט-0.5' then 'record_minus_0_5'
      when 'תקליט-1' then 'record_minus_1'
      when 'תקליט-1.5' then 'record_minus_1_5'
      when 'תקליט-2' then 'record_minus_2'
      when 'תקליט+0.5' then 'record_plus_0_5'
      when 'תקליט+1' then 'record_plus_1'
      when 'תקליט+1.5' then 'record_plus_1_5'
      when 'תקליט+2' then 'record_plus_2'
      when 'מספר' then 'fixed'
      when 'טווח' then 'range'
    end;
  if v_key is not null then
    return v_key::public.price_type;
  end if;

  if p_price is not null then
    return 'fixed';
  end if;
  if p_price_range_from is not null and p_price_range_to is not null then
    return 'range';
  end if;
  return null;
end;
$$;

-- 4. The two columns. Skipped once a column is the type already.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'product_varieties'
      and column_name = 'price_type' and data_type = 'text'
  ) then
    alter table public.product_varieties
      alter column price_type type public.price_type
      using public.price_type_from_text_0100(price_type, price, price_range_from, price_range_to);
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'arrangement_records'
      and column_name = 'price_type' and data_type = 'text'
  ) then
    alter table public.arrangement_records
      alter column price_type type public.price_type
      using public.price_type_from_text_0100(price_type, price, price_range_from, price_range_to);
  end if;
end;
$$;

drop function if exists public.price_type_from_text_0100(text, numeric, numeric, numeric);

comment on column public.product_varieties.price_type is
  'Which price is shown (migration 0100, public.price_type): fixed shows price, range shows price_range_from–price_range_to, a record_* type its own name and no number. Null: no type — the numbers there are, a fixed price first.';
comment on column public.arrangement_records.price_type is
  'The record''s price type (public.price_type, migration 0100): set by the distributor on the record, or copied from its product by close_arrangement''s pricing step (populate_arrangement_prices). It decides what the closing message shows: fixed the price, range the range, a record_* type its name.';

-- 5. save_product: 0094's, with the type checked (step 1's codes).
create or replace function public.save_product(
  p_id uuid,
  p_family_id uuid,
  p_name text,
  p_sizes text,
  p_pack_type public.pack_type,
  p_price numeric,
  p_price_range_from numeric,
  p_price_range_to numeric,
  p_price_type text,
  p_no_overbooking numeric,
  p_highlight_price_fluctuations boolean,
  p_is_seasonal_available boolean,
  p_number_of_orders_per_customer integer,
  p_expected_version integer,
  p_customer_pallet_caps jsonb default null,
  p_image_url text default null
)
returns public.product_varieties
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_product public.product_varieties;
  v_price_type public.price_type;
begin
  -- SECURITY: ALLOWS only backoffice staff to add or change a product.
  -- PROTECTS AGAINST customers, growers, a signed-in account with no
  -- profile and a signed-out caller — `is distinct from` counts a NULL
  -- role (no profile) as a mismatch (0087). Being SECURITY INVOKER, the
  -- write also goes through the caller's own row-level security
  -- (product_varieties_write_backoffice).
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  -- 0100: one of the price types (public.price_type), sent as its code.
  -- Anything else is refused here (22P02: invalid input value for enum).
  v_price_type := nullif(btrim(p_price_type), '')::public.price_type;

  if p_id is null then
    insert into public.product_varieties (
      family_id, name, sizes, pack_type, price, price_range_from, price_range_to,
      price_type, no_overbooking, highlight_price_fluctuations, is_seasonal_available,
      number_of_orders_per_customer, version, image_url
    )
    values (
      p_family_id, p_name, p_sizes, p_pack_type, p_price, p_price_range_from, p_price_range_to,
      v_price_type, p_no_overbooking, p_highlight_price_fluctuations, p_is_seasonal_available,
      p_number_of_orders_per_customer, 1, nullif(btrim(p_image_url), '')
    )
    returning * into v_product;
  else
    update public.product_varieties
    set family_id = p_family_id,
        name = p_name,
        sizes = p_sizes,
        pack_type = p_pack_type,
        price = p_price,
        price_range_from = p_price_range_from,
        price_range_to = p_price_range_to,
        price_type = v_price_type,
        no_overbooking = p_no_overbooking,
        highlight_price_fluctuations = p_highlight_price_fluctuations,
        is_seasonal_available = p_is_seasonal_available,
        number_of_orders_per_customer = p_number_of_orders_per_customer,
        -- 0094: not sent keeps the stored picture; empty text removes it.
        image_url = case when p_image_url is null then image_url else nullif(btrim(p_image_url), '') end,
        version = version + 1,
        updated_at = now()
    where id = p_id and version = p_expected_version
    returning * into v_product;

    if not found then
      if exists (select 1 from public.product_varieties where id = p_id) then
        raise exception
          'CONFLICT: product % was modified by someone else since it was loaded (expected version %)',
          p_id, p_expected_version
          using errcode = 'P0003';
      else
        raise exception 'NOT_FOUND: product % does not exist', p_id using errcode = 'P0002';
      end if;
    end if;
  end if;

  return v_product;
end;
$$;

-- 6. The arrangement record writers: 0021's and 0040's, with the type
-- checked the same way.
create or replace function public.create_arrangement_record(
  p_daily_pick_product_id uuid,
  p_daily_order_product_id uuid,
  p_quantity_pallets numeric,
  p_price numeric default null,
  p_price_type text default null
)
returns public.arrangement_records
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pick_variety uuid;
  v_pick_trading_day uuid;
  v_order_variety uuid;
  v_order_trading_day uuid;
  v_customer_company_id uuid;
  v_arrangement public.daily_arrangements;
  v_record public.arrangement_records;
begin
  if public.current_role() <> 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select dpp.product_variety_id, dp.trading_day_id
    into v_pick_variety, v_pick_trading_day
  from public.daily_pick_products dpp
  join public.daily_picks dp on dp.id = dpp.daily_pick_id
  where dpp.id = p_daily_pick_product_id;
  if not found then
    raise exception 'NOT_FOUND: pick line % does not exist', p_daily_pick_product_id using errcode = 'P0002';
  end if;

  select dop.product_variety_id, do2.trading_day_id, do2.customer_company_id
    into v_order_variety, v_order_trading_day, v_customer_company_id
  from public.daily_order_products dop
  join public.daily_orders do2 on do2.id = dop.daily_order_id
  where dop.id = p_daily_order_product_id;
  if not found then
    raise exception 'NOT_FOUND: order line % does not exist', p_daily_order_product_id using errcode = 'P0002';
  end if;

  if v_pick_trading_day <> v_order_trading_day then
    raise exception 'INVALID_INPUT: pick line and order line belong to different trading days' using errcode = 'P0008';
  end if;
  if v_pick_variety <> v_order_variety then
    raise exception 'INVALID_INPUT: pick line and order line are different product varieties' using errcode = 'P0008';
  end if;

  select * into v_arrangement from public.daily_arrangements where trading_day_id = v_pick_trading_day for update;
  if not found then
    raise exception 'NOT_FOUND: no daily arrangement exists for this trading day' using errcode = 'P0002';
  end if;
  if v_arrangement.status <> 'open' then
    raise exception 'INVALID_STATE: the arrangement is closed' using errcode = 'P0007';
  end if;

  perform public.check_arrangement_allocation(p_daily_pick_product_id, p_daily_order_product_id, p_quantity_pallets, null);

  insert into public.arrangement_records (
    daily_arrangement_id, daily_pick_product_id, daily_order_product_id,
    customer_company_id, quantity_pallets, price, price_type
  )
  values (
    v_arrangement.id, p_daily_pick_product_id, p_daily_order_product_id,
    v_customer_company_id, p_quantity_pallets, p_price, nullif(btrim(p_price_type), '')::public.price_type
  )
  returning * into v_record;

  return v_record;
end;
$$;

create or replace function public.update_arrangement_record(
  p_id uuid,
  p_quantity_pallets numeric,
  p_price numeric default null,
  p_price_type text default null
)
returns public.arrangement_records
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_existing public.arrangement_records;
  v_arrangement public.daily_arrangements;
  v_record public.arrangement_records;
begin
  if public.current_role() <> 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select * into v_existing from public.arrangement_records where id = p_id for update;
  if not found then
    raise exception 'NOT_FOUND: arrangement record % does not exist', p_id using errcode = 'P0002';
  end if;

  select * into v_arrangement from public.daily_arrangements where id = v_existing.daily_arrangement_id for update;
  if v_arrangement.status <> 'open' then
    raise exception 'INVALID_STATE: the arrangement is closed' using errcode = 'P0007';
  end if;

  perform public.check_arrangement_allocation(
    v_existing.daily_pick_product_id, v_existing.daily_order_product_id, p_quantity_pallets, p_id
  );

  update public.arrangement_records
  set quantity_pallets = p_quantity_pallets,
      price = p_price,
      price_type = nullif(btrim(p_price_type), '')::public.price_type,
      updated_at = now()
  where id = p_id
  returning * into v_record;

  return v_record;
end;
$$;

create or replace function public.arrange_to_customer(
  p_daily_pick_product_id uuid,
  p_customer_company_id uuid,
  p_quantity_pallets numeric,
  p_price numeric default null,
  p_price_type text default null
)
returns public.arrangement_records
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_variety_id uuid;
  v_trading_day_id uuid;
  v_arrangement public.daily_arrangements;
  v_order public.daily_orders;
  v_order_line_id uuid;
  -- Read as separate scalars rather than into a row variable. A SELECT INTO
  -- that matches nothing leaves a row variable in a state whose field access
  -- is not worth relying on; a scalar is simply NULL, which is exactly the
  -- "there is no record yet" test the branch below makes.
  v_existing_id uuid;
  v_existing_price numeric;
  v_existing_price_type public.price_type;
  v_record public.arrangement_records;
begin
  if public.current_role() <> 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select dpp.product_variety_id, dp.trading_day_id
    into v_variety_id, v_trading_day_id
  from public.daily_pick_products dpp
  join public.daily_picks dp on dp.id = dpp.daily_pick_id
  where dpp.id = p_daily_pick_product_id;
  if not found then
    raise exception 'NOT_FOUND: pick line % does not exist', p_daily_pick_product_id using errcode = 'P0002';
  end if;

  -- Locked before anything is written, so a close_arrangement running
  -- concurrently either finishes first (and this raises INVALID_STATE) or
  -- waits for this to commit. Without the lock a record could be inserted
  -- into an arrangement that is being closed and would miss pricing.
  select * into v_arrangement
  from public.daily_arrangements
  where trading_day_id = v_trading_day_id
  for update;
  if not found then
    raise exception 'NOT_FOUND: no arrangement exists for trading day %', v_trading_day_id using errcode = 'P0002';
  end if;
  if v_arrangement.status <> 'open' then
    raise exception 'INVALID_STATE: the arrangement is closed' using errcode = 'P0007';
  end if;

  -- The order HEADER must already exist — open_shop bootstraps one per
  -- active customer. Not creating one here is deliberate: a missing header
  -- means this customer wasn't trading today, and inventing one would
  -- quietly enrol them in the day.
  select * into v_order
  from public.daily_orders
  where trading_day_id = v_trading_day_id
    and customer_company_id = p_customer_company_id
  for update;
  if not found then
    raise exception 'NOT_FOUND: no daily order exists for company % on trading day %', p_customer_company_id, v_trading_day_id using errcode = 'P0002';
  end if;

  -- Find-or-create on the natural key, the same upsert shape as
  -- submit_order and bootstrap_grower_pick (R3). `do nothing` rather than
  -- `do update`: if the customer really did order this variety, their
  -- quantity is theirs and this function has no business touching it.
  insert into public.daily_order_products (daily_order_id, product_variety_id, pallets_ordered)
  values (v_order.id, v_variety_id, 0)
  on conflict (daily_order_id, product_variety_id) do nothing;

  select id into v_order_line_id
  from public.daily_order_products
  where daily_order_id = v_order.id
    and product_variety_id = v_variety_id
  for update;

  select id, price, price_type
    into v_existing_id, v_existing_price, v_existing_price_type
  from public.arrangement_records
  where daily_pick_product_id = p_daily_pick_product_id
    and daily_order_product_id = v_order_line_id
  for update;

  -- NULL on the way in when there is no record yet, which is what
  -- check_arrangement_allocation's p_excluding_record_id expects.
  perform public.check_arrangement_allocation(
    p_daily_pick_product_id, v_order_line_id, p_quantity_pallets, v_existing_id
  );

  if v_existing_id is not null then
    update public.arrangement_records
    set quantity_pallets = p_quantity_pallets,
        -- COALESCE, where update_arrangement_record assigns unconditionally.
        -- That function is the records table's full-row editor and clearing
        -- a price there is a real intent; this one is a quantity button, and
        -- omitting the price must not be a way to silently wipe the figure
        -- close_arrangement will notify the customer about.
        price = coalesce(p_price, v_existing_price),
        price_type = coalesce(nullif(btrim(p_price_type), '')::public.price_type, v_existing_price_type),
        updated_at = now()
    where id = v_existing_id
    returning * into v_record;
  else
    insert into public.arrangement_records (
      daily_arrangement_id,
      daily_pick_product_id,
      daily_order_product_id,
      customer_company_id,
      quantity_pallets,
      price,
      price_type
    )
    values (
      v_arrangement.id,
      p_daily_pick_product_id,
      v_order_line_id,
      p_customer_company_id,
      p_quantity_pallets,
      p_price,
      nullif(btrim(p_price_type), '')::public.price_type
    )
    returning * into v_record;
  end if;

  return v_record;
end;
$$;

-- 7. The shop's catalog: 0094's, returning the type's code as text.
create or replace function public.get_orderable_catalog_for_customer(
  p_trading_day_id uuid,
  p_customer_company_id uuid default null
)
returns table (
  family_id uuid,
  family_name text,
  variety_id uuid,
  variety_name text,
  sizes text,
  pack_type public.pack_type,
  price numeric,
  price_range_from numeric,
  price_range_to numeric,
  price_type text,
  is_orderable boolean,
  pallets_ordered numeric,
  comment text,
  image_url text,
  max_orderable_for_customer numeric,
  -- 0094: the variety's own picture (product_varieties.image_url); null when it has none.
  variety_image_url text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_target_company_id uuid;
  v_staff_view boolean;
  v_customer_caller boolean;
  v_caller_sees_prices boolean;
  v_caller_category public.produce_category;
begin
  if p_customer_company_id is not null then
    if public.current_role() is distinct from 'backoffice' then
      raise exception 'FORBIDDEN: only backoffice may query another company''s catalog' using errcode = '42501';
    end if;
    v_target_company_id := p_customer_company_id;
  else
    v_target_company_id := public.current_company_id();
    if v_target_company_id is null then
      raise exception 'FORBIDDEN: no profile for this account' using errcode = '42501';
    end if;
  end if;

  -- The distributor's list or the customer's, by role. `coalesce` because a
  -- role of NULL (no profile) must count as "not backoffice"; such a caller is
  -- refused above anyway.
  v_staff_view := coalesce(public.current_role() = 'backoffice', false);
  v_customer_caller := coalesce(public.current_role() = 'customer', false);

  -- 0090: the customer user's own category (Bubble: the User's "default
  -- product category"). Null or 'both' leaves the list whole.
  if v_customer_caller then
    select p.product_category into v_caller_category
    from public.profiles p
    where p.user_id = (select auth.uid());
  end if;

  -- 0072: PRICES. SECURITY: ALLOWS a customer to see prices only for a day
  -- that is not closed — the day being traded, whose prices these are —
  -- when their own company's can_see_product_prices is on; the day's shop
  -- switch (ds.can_see_prices, in the select below) must be on as well. It
  -- PROTECTS AGAINST a company without price permission seeing prices (Bubble
  -- never showed them one), and against any customer reading today's prices
  -- by passing an older day's id: the prices returned are the varieties'
  -- CURRENT ones, so the switch that guards them must be the current day's,
  -- not the switch of whichever day the caller names. A missing permission
  -- or a day that does not exist counts as "no prices". Staff are unchanged:
  -- they see prices whenever the day's shop shows them.
  if v_staff_view then
    v_caller_sees_prices := true;
  else
    select coalesce(c.can_see_product_prices, false) and td.phase <> 'closed'
    into v_caller_sees_prices
    from public.companies c
    cross join public.trading_days td
    where c.id = v_target_company_id
      and td.id = p_trading_day_id;
    v_caller_sees_prices := coalesce(v_caller_sees_prices, false);
  end if;

  return query
  select
    pf.id as family_id,
    pf.name as family_name,
    pv.id as variety_id,
    pv.name as variety_name,
    pv.sizes,
    pv.pack_type,
    case when v_caller_sees_prices and ds.can_see_prices then pv.price else null end as price,
    case when v_caller_sees_prices and ds.can_see_prices then pv.price_range_from else null end as price_range_from,
    case when v_caller_sees_prices and ds.can_see_prices then pv.price_range_to else null end as price_range_to,
    -- 0100: the type's code, as text — the column is public.price_type now.
    case when v_caller_sees_prices and ds.can_see_prices then pv.price_type::text else null end as price_type,
    sv.is_orderable,
    coalesce(dop.pallets_ordered, 0) as pallets_ordered,
    dop.comment,
    pf.image_url,
    public.max_orderable_for_customer(p_trading_day_id, pv.id, v_target_company_id) as max_orderable_for_customer,
    -- 0094: the variety's own picture — the customer screen's "לחצו כאן לתמונה עדכנית".
    pv.image_url as variety_image_url
  from public.shop_variety_orderability(p_trading_day_id) sv
  join public.product_varieties pv on pv.id = sv.product_variety_id
  join public.product_families pf on pf.id = pv.family_id
  join public.daily_shops ds on ds.trading_day_id = p_trading_day_id
  -- Picking per variety for this day, across every grower and whatever the
  -- state of their pick (a draft counts, as it does in shop_variety_orderability).
  -- Both columns are NOT NULL, so the sum is never null.
  left join (
    select dpp.product_variety_id, sum(dpp.pallets_picked) + sum(dpp.leftover_pallets) as total
    from public.daily_pick_products dpp
    join public.daily_picks dp on dp.id = dpp.daily_pick_id
    where dp.trading_day_id = p_trading_day_id
    group by dpp.product_variety_id
  ) picking on picking.product_variety_id = pv.id
  left join public.daily_orders ord
    on ord.trading_day_id = p_trading_day_id
    and ord.customer_company_id = v_target_company_id
  left join public.daily_order_products dop
    on dop.daily_order_id = ord.id
    and dop.product_variety_id = pv.id
  where
    -- A customer: has picking, and either still has room to order or is already
    -- in their own order. no_overbooking is deliberately not part of "has
    -- picking": it only stretches how much of a picked product can be ordered
    -- (that is is_orderable's job), it is not stock.
    (not v_staff_view
      and coalesce(picking.total, 0) > 0
      and (sv.is_orderable or dop.id is not null)
      -- 0072: BLOCKED PRODUCTS. SECURITY: ALLOWS a customer to be shown only
      -- the products that are not on their own blocked list — even one
      -- already in their company's order, as in Bubble, where the list
      -- filtered every product the customer was shown. It PROTECTS AGAINST a
      -- blocked product being offered to, and so ordered by, the customer it
      -- was blocked for. Their own list only: a colleague in the same company
      -- is unaffected, and so is staff's list (the other branch below).
      and not (v_customer_caller and exists (
        select 1 from public.profile_blocked_products b
        where b.user_id = (select auth.uid())
          and b.product_variety_id = pv.id
      ))
      -- 0090: CATEGORY. A customer set to fruit or vegetable sees the families
      -- of that category and the "both" ones — and any product already on
      -- their order with pallets, which their next save would otherwise
      -- delete. A filter on what is offered, not a permission: staff lists
      -- (the other branch below) are unchanged, as in Bubble.
      and (v_caller_category is null
        or v_caller_category = 'both'
        or pf.category = v_caller_category
        or pf.category = 'both'
        or coalesce(dop.pallets_ordered, 0) > 0))
    -- A distributor: everything that has picking, fully ordered or not, plus
    -- whatever is already in the order they are looking at.
    or (v_staff_view
      and (coalesce(picking.total, 0) > 0 or dop.id is not null))
  order by pf.name, pv.name;
end;
$$;

-- 8. The end-of-day pricing: 0083's, by price type.
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
  -- 0100: by price type. Only a record with no price of its own; its type
  -- is its own if it has one, otherwise its product's:
  --   - מספר (fixed): the product's price is copied;
  --   - טווח (range): the product's range is copied as its two ends, and the
  --     record's price stays empty (0083);
  --   - a תקליט type: there is no number to copy — only the type is, so the
  --     closing message can name it;
  --   - no type on either: 0083's rule — a fixed price if the product has
  --     one, otherwise both ends of its range.
  -- A number the product's type hides (a price left on a טווח or תקליט
  -- product from before) is never copied.
  with unpriced as (
    select
      ar.id,
      coalesce(ar.price_type, pv.price_type) as price_type,
      ar.price_type is null as type_from_product,
      pv.price,
      pv.price_range_from,
      pv.price_range_to
    from public.arrangement_records ar
    join public.daily_pick_products dpp on dpp.id = ar.daily_pick_product_id
    join public.daily_picks dp on dp.id = dpp.daily_pick_id
    join public.product_varieties pv on pv.id = dpp.product_variety_id
    where dp.trading_day_id = p_trading_day_id
      and ar.price is null
      and ar.price_range_from is null
  )
  update public.arrangement_records ar
  set price = case when u.price_type = 'fixed' or u.price_type is null then u.price end,
      price_range_from = case
        when u.price_type = 'range' or (u.price_type is null and u.price is null) then u.price_range_from
      end,
      price_range_to = case
        when u.price_type = 'range' or (u.price_type is null and u.price is null) then u.price_range_to
      end,
      price_type = u.price_type,
      updated_at = now()
  from unpriced u
  where ar.id = u.id
    and (
      (u.price_type = 'fixed' and u.price is not null)
      or (u.price_type = 'range' and u.price_range_from is not null and u.price_range_to is not null)
      or (u.price_type not in ('fixed', 'range') and u.type_from_product)
      or (u.price_type is null
        and (u.price is not null or (u.price_range_from is not null and u.price_range_to is not null)))
    );
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

comment on function public.populate_arrangement_prices(uuid) is
  'Backoffice-only. Prices any un-priced arrangement_records row for this trading day by its price type — its own, else its product''s (0100): fixed copies the product''s price; range copies both ends of its range and leaves price empty (D8, 0083); a record_* (תקליט) type copies only the type, there being no number. With no type on either, the product''s fixed price, else both ends of its range (0083). A number the product''s type hides is never copied; a row with nothing to copy is left as it is (0065). Returns how many rows it changed.';

-- 9. The closing messages: 0083's, with each customer line's price type
-- (under the same price rule as its price).
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
        -- 0100: the record's price type, under the same rule as its price.
        'priceType', case when v_can_see_prices and cc.can_see_product_prices then ar.price_type end,
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

-- 10. A line's price in a message: 0085's, by price type.
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
      -- 0100: by price type — מספר shows the price, טווח the range, a
      -- תקליט type its own name. A line with no type (a message queued
      -- before 0100, or a record and product with none): 0083's rule.
      case
        when line ->> 'priceType' not in ('fixed', 'range')
          and public.price_type_label(line ->> 'priceType') is not null
          then ' — ' || public.price_type_label(line ->> 'priceType')
        when line ->> 'priceType' = 'fixed'
          then case when line ->> 'price' is not null then format(' — ₪%s', line ->> 'price') else '' end
        when line ->> 'priceType' = 'range'
          then case
            when line ->> 'priceRangeFrom' is not null and line ->> 'priceRangeTo' is not null
              then format(' — ₪%s–₪%s', line ->> 'priceRangeFrom', line ->> 'priceRangeTo')
            else ''
          end
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
