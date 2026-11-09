-- Workbook Task 32 (item 3) — a customer sees only their own category.
--
-- James (2026-11-09), confirmed against live Bubble: products are fruit,
-- vegetable or both, and a customer set to a category sees only that
-- category's products and the "both" ones — a customer set to vegetable sees
-- vegetable and both. In Bubble the category is the CUSTOMER USER's own
-- ("default product category" on the User; the Company field of the same name
-- is empty everywhere) and the product family's "Product Categories" list
-- (["פרי"], ["ירק"], or both, e.g. watermelon and melons). Bubble's shop list
-- leaves out every family whose list lacks the user's category — only for a
-- customer, and nothing for a user set to "פרי / ירק" or to nothing. Staff
-- ordering on a customer's behalf see everything.
--
-- 1. produce_category: 'fruit' (פרי), 'vegetable' (ירק), 'both' (פרי / ירק).
-- 2. product_families.category, free text until now, becomes one of those.
--    The text already there is read as follows; anything else becomes empty
--    (to see what is there before running this, read-only:
--      select category, count(*) from public.product_families group by 1;):
--      פרי, פירות, fruit                  → fruit
--      ירק, ירקות, vegetable              → vegetable
--      פרי / ירק (any spacing), both      → both
--    The 12 October import kept only the FIRST category of a family with
--    two, so the families Bubble has as both (watermelon, the melons) are
--    fruit here until the final import (fixed: it now reads both) or until
--    someone sets them on the Products screen.
-- 3. profiles.product_category: the customer user's category. Empty or
--    'both' means everything.
-- 4. save_user takes it as an optional last argument; left out — as the Users
--    screen deployed today leaves it — it keeps the user's category. The body
--    is 0007's apart from that and the role check (`is distinct from`).
-- 5. get_orderable_catalog_for_customer leaves out, for a customer's own list,
--    the families outside their category — and keeps any product already on
--    their order with pallets: the order screen sends back only the lines it
--    shows, and submit_order removes every line it is not sent, so hiding one
--    would delete it on their next save. (Bubble hid those too, but Bubble
--    saved only the lines a user changed.) A family with no category is
--    outside every category. Staff lists are unchanged. The body is 0072's
--    apart from the block marked "0090".
--
-- Rollout: run before pushing the web app. The app deployed today keeps
-- working; until the new one is live, its Products screen's free-text
-- category box can save only fruit, vegetable or both. Safe to run again.

-- 1. The three categories.
do $$
begin
  create type public.produce_category as enum ('fruit', 'vegetable', 'both');
exception
  when duplicate_object then null;
end
$$;

-- 2. A product family's category.
do $$
begin
  if (
    select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'product_families' and column_name = 'category'
  ) = 'text' then
    alter table public.product_families
      alter column category type public.produce_category
      using (
        case
          when btrim(category) in ('פרי', 'פירות', 'fruit') then 'fruit'
          when btrim(category) in ('ירק', 'ירקות', 'vegetable') then 'vegetable'
          when replace(btrim(category), ' ', '') in ('פרי/ירק', 'ירק/פרי', 'both') then 'both'
          else null
        end
      )::public.produce_category;
  end if;
end
$$;

comment on column public.product_families.category is
  'Fruit, vegetable or both (migration 0090). A customer user with a category sees only the families of that category and the "both" ones (get_orderable_catalog_for_customer).';

-- 3. A customer user's category.
alter table public.profiles
  add column if not exists product_category public.produce_category;

comment on column public.profiles.product_category is
  'The customer user''s category (Bubble''s "default product category"): they see only products of this category and "both" ones. Null or both = everything. Read only for customers (migration 0090).';

-- 4. save_user, with the category.
drop function if exists public.save_user(uuid, text, public.user_role, uuid, uuid[]);

-- SECURITY: ALLOWS backoffice to change a user's name, role, company, blocked
-- products and category. PROTECTS AGAINST anyone else doing so: the function
-- refuses every caller but backoffice (a caller with no profile has a NULL
-- role, refused by `is distinct from`), and being SECURITY INVOKER it writes
-- through the caller's own row-level security as well. Anonymous callers
-- cannot run it (EXECUTE revoked below).
create or replace function public.save_user(
  p_user_id uuid,
  p_display_name text,
  p_role public.user_role,
  p_company_id uuid,
  p_blocked_product_variety_ids uuid[],
  p_product_category public.produce_category default null
)
returns public.profiles
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_profile public.profiles;
begin
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  update public.profiles
  set display_name = p_display_name,
      role = p_role,
      company_id = p_company_id,
      -- 0090: left out, the category stays as it is.
      product_category = coalesce(p_product_category, product_category),
      updated_at = now()
  where user_id = p_user_id
  returning * into v_profile;

  if not found then
    raise exception 'NOT_FOUND: user % does not exist', p_user_id using errcode = 'P0002';
  end if;

  delete from public.profile_blocked_products
  where user_id = v_profile.user_id
    and not (product_variety_id = any(coalesce(p_blocked_product_variety_ids, array[]::uuid[])));

  insert into public.profile_blocked_products (user_id, product_variety_id)
  select v_profile.user_id, pv_id
  from unnest(coalesce(p_blocked_product_variety_ids, array[]::uuid[])) as pv_id
  on conflict (user_id, product_variety_id) do nothing;

  return v_profile;
end;
$$;

comment on function public.save_user(uuid, text, public.user_role, uuid, uuid[], public.produce_category) is
  'Backoffice-only. Updates a user''s display name, role and company, replaces their blocked products, and sets their product category — p_product_category left out (null) keeps the current one (migration 0090).';

revoke execute on function public.save_user(uuid, text, public.user_role, uuid, uuid[], public.produce_category) from public, anon;
grant execute on function public.save_user(uuid, text, public.user_role, uuid, uuid[], public.produce_category) to authenticated;

-- 5. The customer's list, in their category.
-- SECURITY (unchanged from 0064 and 0072, restated because the function is
-- replaced; the category is a filter, not a permission — see 0090 below):
-- which of the two lists a caller gets is decided by their ROLE, read from
-- their profile (current_role()), never by anything they pass in. That ALLOWS
-- backoffice to see fully ordered products and existing order lines that
-- customers do not, and it PROTECTS AGAINST a customer asking for the
-- distributor's list: there is no parameter that switches it, and the only
-- parameter that reaches another company's catalog (p_customer_company_id) is
-- still refused for everyone but backoffice (42501). ALLOWS a signed-in user
-- with a profile to read the catalog for THEIR OWN company, and backoffice to
-- read any customer's. PROTECTS AGAINST a caller with no profile (`is
-- distinct from` counts "no role" as "not backoffice", and a caller with no
-- company of their own is refused outright — this function runs as its
-- owner, so RLS is not there to catch either case) and anonymous calls
-- (execute is revoked from anon below). The picking check reads every
-- grower's pick lines, which the caller could not read themselves; it only
-- decides whether a row is listed at all, and no pick line or other company's
-- figure is ever returned.
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
  max_orderable_for_customer numeric
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
    public.max_orderable_for_customer(p_trading_day_id, pv.id, v_target_company_id) as max_orderable_for_customer
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
  'Security definer (migration 0056), so customers — who cannot read product_varieties directly — can still browse the catalog. A signed-in user with a profile reads their own company''s catalog (p_customer_company_id omitted); backoffice may pass p_customer_company_id to read any customer''s — raises FORBIDDEN for any other caller, and for an account with no profile. Customers and distributors get different lists, chosen by the caller''s role (never by a parameter), migration 0064. Picking = pallets_picked + leftover_pallets summed over every grower for the day; no_overbooking is not picking. A CUSTOMER sees a variety when it has picking AND it is not fully ordered (is_orderable), or when it has picking and is already in their own order (so a fully ordered product stays visible to whoever ordered it) — except a variety on the calling customer''s own blocked list (profile_blocked_products), which is never shown to them, even when it is in their order (migration 0072); and a customer user with a product category (profiles.product_category: fruit or vegetable) sees only families of that category or both, plus any variety already on their order with pallets (migration 0090). A variety whose picking is 0 is not shown to a customer even if it is in their order. A DISTRIBUTOR (backoffice) sees every variety that has picking, fully ordered or not (is_orderable is false for those), plus every line already in the target company''s order whatever its picking; blocked lists do not apply to them. Prices: a customer gets them only when the day is not closed, the day''s daily_shops.can_see_prices is on AND their company''s can_see_product_prices is on (migration 0072, as in Bubble); backoffice gets them whenever the day''s daily_shops.can_see_prices is on. This is the only way a customer sees a price. sizes is the variety''s free-text size descriptor (product_varieties.sizes), meant to be shown beside variety_name. image_url is the variety''s family''s photo. max_orderable_for_customer is the target company''s own ceiling for that row (see max_orderable_for_customer()) — always populated, including on the backoffice on-behalf-of path, but only the customer''s own order screen''s UI treats it as a hard limit; the backoffice edit path lets staff override it.';

-- SECURITY: ALLOWS only signed-in users to run the function; PROTECTS AGAINST
-- anonymous callers (no session) reaching it at all. `create or replace` keeps
-- the grants it had, and these two lines state them again so this file is the
-- whole truth about who may call it.
revoke execute on function public.get_orderable_catalog_for_customer(uuid, uuid) from public, anon;
grant execute on function public.get_orderable_catalog_for_customer(uuid, uuid) to authenticated;
