-- Release workbook Task 36 — the customer's preferred grower. The client's
-- request: "When more than one grower has the selected variety in stock for
-- the business day, show a small button allowing the customer to choose a
-- preferred grower. Add that choice only to the existing order comment
-- field; it must not affect allocation or other business logic."
--
-- The order screen cannot tell on its own when that is. A customer cannot
-- read growers' picks or companies (row-level security, 0066), and the shop
-- catalog adds every grower's picking into one total. This adds one
-- read-only function, get_variety_growers_for_customer: for the varieties
-- the caller is shown in the shop that day, the NAMES of the growers that
-- have each one in stock — only where two or more do, and nothing else about
-- them. The choice itself is plain text the order screen writes into that
-- product line's own comment ("מגדל מועדף: <name>"), saved with the line by
-- submit_order like any comment; nothing in the database reads it. No
-- table, trigger, policy or other function changes: allocation, arranging,
-- stock, messages and submit_order are as they were.
--
-- "In stock" is the shop's own "picking", per grower instead of summed: that
-- grower's line for the variety on that day has pallets_picked +
-- leftover_pallets above zero, whatever the state of the pick (a draft
-- counts) — the catalog's "picking" subquery (0094). Only active growers are
-- named.
--
-- Security: it runs with the owner's rights (security definer), which is how
-- it can read picks and companies at all, so it decides itself who gets an
-- answer — a customer for their own company and backoffice for any, the
-- catalog's rule — and refuses everyone else, a grower included (who could
-- otherwise learn which competitors have a product today). A customer is
-- answered only for a day whose shop is open, the only time their order can
-- change, so no earlier day's growers can be read back. And it names growers
-- only for the varieties the catalog itself shows the same caller, so
-- blocked products, categories and the customer/staff lists keep applying.
-- The SECURITY notes below say how.
--
-- Rollout: the web app can be deployed first — the button simply does not
-- appear until this migration runs (the app reads a failed call as "no
-- growers", and nothing else on the order screen depends on it). A web app
-- from before it never calls the function.
--
-- Safe to run again.

create or replace function public.get_variety_growers_for_customer(
  p_trading_day_id uuid,
  p_customer_company_id uuid default null
)
returns table (
  variety_id uuid,
  grower_name text
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  -- SECURITY: ALLOWS backoffice to name any customer's company (the
  -- on-behalf-of order screens: בשם לקוח and the board's pencil), and a
  -- customer to read their own company's — the catalog's two paths (0056,
  -- 0094). PROTECTS AGAINST a customer naming a company, even their own
  -- (42501, as the catalog); a signed-in account with no profile, or whose
  -- company is inactive (current_role() and current_company_id() return
  -- nothing for both, 0088); and — stricter than the catalog, which a grower
  -- may read (0076) — a grower: growers may not read one another's picks or
  -- companies (0066), and this would tell one which competitors have a
  -- product in stock today. `is distinct from` counts a missing role as a
  -- mismatch. Signed-out callers cannot run it at all (the grants below).
  -- current_role() and current_company_id() read the request's own sign-in
  -- (auth.uid()), not the database role this runs as.
  if p_customer_company_id is not null then
    if public.current_role() is distinct from 'backoffice' then
      raise exception 'FORBIDDEN: only backoffice may query another company''s growers' using errcode = '42501';
    end if;
  elsif public.current_role() is distinct from 'customer'
        and public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: only a customer or backoffice may read the growers of a shop' using errcode = '42501';
  elsif public.current_company_id() is null then
    raise exception 'FORBIDDEN: no profile for this account' using errcode = '42501';
  end if;

  -- SECURITY: ALLOWS a customer names only for a day whose shop is open
  -- (phase shop_open) — the only time their own order can change (0071), and
  -- so the only time the button shows. PROTECTS AGAINST a customer naming an
  -- earlier day: every day's id is readable (0010) and the catalog lists a
  -- closed day's products too, so one call per day would otherwise give the
  -- history of which growers had which product in stock. Backoffice may name
  -- any day: staff still change an order after the shop closes, and read
  -- picks and companies directly anyway (0066). No rows rather than an
  -- error, so a screen still open as the shop closes just loses the button.
  if public.current_role() is distinct from 'backoffice'
     and not exists (
       select 1
       from public.trading_days td
       where td.id = p_trading_day_id
         and td.phase = 'shop_open'
     ) then
    return;
  end if;

  return query
  with
  -- SECURITY: ALLOWS growers to be named only for the varieties the caller
  -- is shown in the shop — exactly the catalog's own rows, for the same day
  -- and company. PROTECTS AGAINST naming the growers of a product blocked
  -- for this customer user (0072), outside their category (0090), or not on
  -- their list at all (no picking, or fully ordered by others — 0064),
  -- without restating those rules here, where the two copies could drift
  -- apart. Calling the catalog from this function keeps every one of its
  -- rules for the real caller: it asks who is calling through auth.uid()
  -- (directly, and inside current_role() and current_company_id()), which
  -- reads the request's sign-in whatever database role runs it — the same
  -- reason the catalog, itself security definer, applies the caller's own
  -- blocked list today.
  shown as (
    select distinct c.variety_id
    from public.get_orderable_catalog_for_customer(p_trading_day_id, p_customer_company_id) c
  ),
  -- Who has each of those in stock: a grower's NAME, and nothing else about
  -- them, leaves this function. Two growers with the same name are one
  -- choice — the customer could not tell them apart — so names are counted
  -- once. `type = 'grower'` so no other company's name can ever be shown,
  -- even through a pick row that should not exist.
  in_stock as (
    select distinct dpp.product_variety_id as variety_id, gc.name as grower_name
    from public.daily_pick_products dpp
    join public.daily_picks dp on dp.id = dpp.daily_pick_id
    join public.companies gc on gc.id = dp.grower_company_id
    join shown s on s.variety_id = dpp.product_variety_id
    where dp.trading_day_id = p_trading_day_id
      -- Both columns are NOT NULL (0050), so the sum is never null.
      and dpp.pallets_picked + dpp.leftover_pallets > 0
      and gc.type = 'grower'
      and gc.status = 'active'
  )
  select i.variety_id, i.grower_name
  from in_stock i
  -- A choice only where there is one: two or more growers.
  where i.variety_id in (
    select i2.variety_id
    from in_stock i2
    group by i2.variety_id
    having count(*) >= 2
  )
  order by i.variety_id, i.grower_name;
end;
$$;

comment on function public.get_variety_growers_for_customer(uuid, uuid) is
  'Workbook Task 36 (migration 0095): the names of the growers that have each variety in stock on p_trading_day_id — pallets_picked + leftover_pallets above zero on that grower''s line for the day, whatever the state of the pick; active growers only — for the varieties get_orderable_catalog_for_customer shows the caller (same day, same company), and only where two or more growers (counted by name) do. One row per (variety_id, grower_name), ordered by variety then name; nothing else about the growers. A customer reads their own company''s (p_customer_company_id omitted), and only while that day''s shop is open (phase shop_open) — for any other day they get no rows; backoffice may pass p_customer_company_id to read any customer''s, on any day, as with the catalog. Raises FORBIDDEN (42501) for anyone else — a customer passing any company id, a grower, an account with no profile or of an inactive company. Read-only: it backs the order screen''s "מגדל מועדף" button, whose choice is written into the order line''s own comment as plain text and read by nothing in the database (allocation, arranging and stock are unchanged).';

-- SECURITY: ALLOWS signed-in users and the service role to call it; inside,
-- only a customer (their own company) and backoffice (any company) get an
-- answer. PROTECTS AGAINST anonymous callers (no session) reaching it at all:
-- a new function is executable by PUBLIC (and, on Supabase, by anon) until
-- revoked.
revoke execute on function public.get_variety_growers_for_customer(uuid, uuid) from public, anon;
grant execute on function public.get_variety_growers_for_customer(uuid, uuid) to authenticated, service_role;
