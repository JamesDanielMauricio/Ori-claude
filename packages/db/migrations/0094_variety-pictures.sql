-- Bubble column parity, part 3 (docs/superpowers/specs/2026-11-10-bubble-column-parity-design.md §6).
--
-- Bubble keeps a picture per variety — on the products screens, and behind
-- the customer's "לחצו כאן לתמונה עדכנית" — while Ori had only the family's.
-- This adds product_varieties.image_url, teaches save_product to write it,
-- and has get_orderable_catalog_for_customer return it as variety_image_url.
--
-- The rule for the new input (as 0082, 0092 and 0093): not sent keeps the
-- stored picture; empty text removes it; other text is saved trimmed. So a
-- products screen still running the previous web app cannot wipe a picture.
--
-- Pictures live in the existing product-photos storage bucket (0058); its
-- rules are unchanged: anyone with a picture's link can view it, only the
-- back office can upload or delete, and only JPEG, PNG or WebP up to 5 MB.
--
-- Both functions keep their latest bodies (save_product 0087, the catalog
-- 0090) apart from the picture — and a SECURITY comment on save_product's
-- role check, which had none. The catalog's result changes, so it is dropped
-- and recreated (as 0036 did), with its permissions restated.
--
-- Run it before the web app from the same release goes live. Copies of the
-- app from before it keep working: they leave the new input out, and an
-- extra catalog column is ignored.
--
-- Safe to run again.

-- 1. The column.
alter table public.product_varieties add column if not exists image_url text;

comment on column public.product_varieties.image_url is
  'The variety''s own picture (Bubble "Image"): a link into the product-photos bucket. NULL when it has none. Migration 0094.';

-- ---------------------------------------------------------------------------
-- 2. save_product with p_image_url. An added parameter makes a NEW function
-- in Postgres, so the old signature is dropped: PostgREST then has exactly
-- one save_product to call.
-- ---------------------------------------------------------------------------
drop function if exists public.save_product(
  uuid, uuid, text, text, public.pack_type, numeric, numeric, numeric, text, numeric,
  boolean, boolean, integer, integer, jsonb
);

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

  if p_id is null then
    insert into public.product_varieties (
      family_id, name, sizes, pack_type, price, price_range_from, price_range_to,
      price_type, no_overbooking, highlight_price_fluctuations, is_seasonal_available,
      number_of_orders_per_customer, version, image_url
    )
    values (
      p_family_id, p_name, p_sizes, p_pack_type, p_price, p_price_range_from, p_price_range_to,
      p_price_type, p_no_overbooking, p_highlight_price_fluctuations, p_is_seasonal_available,
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
        price_type = p_price_type,
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

comment on function public.save_product(
  uuid, uuid, text, text, public.pack_type, numeric, numeric, numeric, text, numeric,
  boolean, boolean, integer, integer, jsonb, text
) is
  'Backoffice-only. Upserts a product variety with optimistic concurrency (p_expected_version must match the current row; raises P0003 on conflict). Pass p_id = null to create (version starts at 1, p_expected_version ignored). p_number_of_orders_per_customer is the variety-level order cap (migration 0042; null = uncapped). p_customer_pallet_caps is ignored: the per-customer cap was removed (migration 0087) and the argument is kept only so a client that still sends it keeps working. p_image_url (0094): the variety''s picture link — null keeps the stored picture, empty text removes it, other text is saved trimmed.';

-- SECURITY: ALLOWS signed-in users and the service role to call save_product
-- — the function then refuses everyone but backoffice, and writes through the
-- caller's own row-level security. PROTECTS AGAINST anonymous callers
-- reaching it at all: dropping a function drops its permissions, and a new
-- function is executable by PUBLIC (and, on Supabase, by anon) until revoked.
revoke execute on function public.save_product(
  uuid, uuid, text, text, public.pack_type, numeric, numeric, numeric, text, numeric,
  boolean, boolean, integer, integer, jsonb, text
) from public, anon;
grant execute on function public.save_product(
  uuid, uuid, text, text, public.pack_type, numeric, numeric, numeric, text, numeric,
  boolean, boolean, integer, integer, jsonb, text
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. get_orderable_catalog_for_customer with variety_image_url. Its result
-- type changes, which create or replace cannot do, so it is dropped first.
-- Everything it decides — who sees which products, blocked products (0072),
-- categories (0090), prices — is 0090's, unchanged; see 0090's comments.
-- ---------------------------------------------------------------------------
drop function if exists public.get_orderable_catalog_for_customer(uuid, uuid);

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
    case when v_caller_sees_prices and ds.can_see_prices then pv.price_type else null end as price_type,
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

comment on function public.get_orderable_catalog_for_customer(uuid, uuid) is
  'Security definer (migration 0056), so customers — who cannot read product_varieties directly — can still browse the catalog. A signed-in user with a profile reads their own company''s catalog (p_customer_company_id omitted); backoffice may pass p_customer_company_id to read any customer''s — raises FORBIDDEN for any other caller, and for an account with no profile. Customers and distributors get different lists, chosen by the caller''s role (never by a parameter), migration 0064. Picking = pallets_picked + leftover_pallets summed over every grower for the day; no_overbooking is not picking. A CUSTOMER sees a variety when it has picking AND it is not fully ordered (is_orderable), or when it has picking and is already in their own order (so a fully ordered product stays visible to whoever ordered it) — except a variety on the calling customer''s own blocked list (profile_blocked_products), which is never shown to them, even when it is in their order (migration 0072); and a customer user with a product category (profiles.product_category: fruit or vegetable) sees only families of that category or both, plus any variety already on their order with pallets (migration 0090). A variety whose picking is 0 is not shown to a customer even if it is in their order. A DISTRIBUTOR (backoffice) sees every variety that has picking, fully ordered or not (is_orderable is false for those), plus every line already in the target company''s order whatever its picking; blocked lists do not apply to them. Prices: a customer gets them only when the day is not closed, the day''s daily_shops.can_see_prices is on AND their company''s can_see_product_prices is on (migration 0072, as in Bubble); backoffice gets them whenever the day''s daily_shops.can_see_prices is on. This is the only way a customer sees a price. sizes is the variety''s free-text size descriptor (product_varieties.sizes), meant to be shown beside variety_name. image_url is the variety''s family''s photo. max_orderable_for_customer is the target company''s own ceiling for that row (see max_orderable_for_customer()) — always populated, including on the backoffice on-behalf-of path, but only the customer''s own order screen''s UI treats it as a hard limit; the backoffice edit path lets staff override it. variety_image_url (0094) is the variety''s own picture (product_varieties.image_url), null when it has none; image_url stays the family''s photo.';

-- SECURITY: ALLOWS signed-in users and the service role to run the catalog;
-- inside, a customer reads only their own company's, and only backoffice may
-- name another company (42501 otherwise). PROTECTS AGAINST anonymous callers
-- (no session) reaching it at all — the drop above removed its permissions,
-- so they are stated again here.
revoke execute on function public.get_orderable_catalog_for_customer(uuid, uuid) from public, anon;
grant execute on function public.get_orderable_catalog_for_customer(uuid, uuid) to authenticated, service_role;
