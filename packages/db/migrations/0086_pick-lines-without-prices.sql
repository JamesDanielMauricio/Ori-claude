-- Workbook Task 30 (item 1), step 1 of 2 — growers stop needing the product
-- table, so it can be closed to them.
--
-- Growers can read every selling price today: product_varieties is readable
-- by backoffice and growers (0056, 0066), because a grower's picking screen
-- shows its lines' product names and reads them from that table — and a row
-- comes with all its columns, the prices included. James (2026-11-09):
-- prices are hidden from growers.
--
-- Row-level security works on whole rows, not columns, and growers use the
-- same database role as staff, so the price columns cannot be cut out of the
-- rows a grower may read. Growers will instead stop reading product_varieties
-- at all — the step 0056 took for customers — and get the one thing their
-- screens need from it, the names on their pick lines, from the function
-- below, which returns the lines without prices.
--
-- This file only ADDS that function; nothing changes for anyone yet. Step 2
-- (0091) closes product_varieties to growers, and is run AFTER the web app
-- that reads pick lines through this function is live — run before it, the
-- grower picking screen deployed today would show its lines without names.
--
-- Nothing else a grower does reads product_varieties: every function that
-- reads it with the caller's own rights is staff-only, and no other security
-- rule or view looks into it (checked against every migration through 0085).
--
-- Safe to run again.

-- SECURITY: ALLOWS a grower to read the lines of their own company's picks,
-- each with its product's name, size, family and family photo — what the
-- picking screen shows — and backoffice to read any pick's lines (the
-- "בשם מגדל" screen uses the same editor). PROTECTS AGAINST a grower reading
-- another grower's pick, a customer or an account with no profile reading
-- any (`is distinct from` / `=` with a NULL role is not true), and anonymous
-- callers (EXECUTE revoked below). Security definer because, once 0091 runs,
-- growers cannot read product_varieties themselves; it returns no price
-- column, so it gives a grower nothing they could not see on screen.
create or replace function public.get_pick_lines(p_daily_pick_id uuid)
returns table (
  id uuid,
  pallets_picked numeric,
  leftover_pallets numeric,
  comment text,
  product_variety_id uuid,
  variety_name text,
  variety_sizes text,
  family_id uuid,
  family_name text,
  family_image_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    dpp.id,
    dpp.pallets_picked,
    dpp.leftover_pallets,
    dpp.comment,
    dpp.product_variety_id,
    pv.name,
    pv.sizes,
    pv.family_id,
    pf.name,
    pf.image_url
  from public.daily_pick_products dpp
  join public.daily_picks dp on dp.id = dpp.daily_pick_id
  join public.product_varieties pv on pv.id = dpp.product_variety_id
  join public.product_families pf on pf.id = pv.family_id
  where dpp.daily_pick_id = p_daily_pick_id
    and (
      public.current_role() = 'backoffice'
      or (public.current_role() = 'grower' and dp.grower_company_id = public.current_company_id())
    )
  order by dpp.product_variety_id;
$$;

comment on function public.get_pick_lines(uuid) is
  'A pick''s lines with each product''s name, size, family and family photo — no prices (migration 0086). For the pick''s own grower, or backoffice; anyone else gets no rows. Security definer, so growers can read their lines once product_varieties is closed to them (0091).';

revoke execute on function public.get_pick_lines(uuid) from public, anon;
grant execute on function public.get_pick_lines(uuid) to authenticated;
