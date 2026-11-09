-- RUN THIS AFTER THE WEB APP FROM THE SAME RELEASE IS LIVE, not before.
--
-- Step 2 of workbook Task 30 items 1 and 2:
--
-- 1. Growers no longer read product_varieties — and with it, every product's
--    selling price (James, 2026-11-09: hidden from growers). Row-level
--    security works on whole rows, so the only way to keep the price columns
--    from a grower is to keep the rows from them; their picking screen reads
--    its lines' names through get_pick_lines (0086) instead. Run before the
--    web app that uses get_pick_lines is live, the grower picking screen
--    deployed until then would show its lines without names.
-- 2. The per-customer pallet cap's table goes. Nothing has written it since
--    0087, and no screen reads it once the new web app is live; the screens
--    deployed until then still read it, and would stop loading without it.
--    Its rows are deleted with it: they never limited anything.
--
-- Safe to run again.

-- 1. product_varieties: staff only.
drop policy if exists "product_varieties_select_backoffice_and_growers" on public.product_varieties;
drop policy if exists "product_varieties_select_backoffice" on public.product_varieties;

-- SECURITY: ALLOWS backoffice to read the catalog's varieties, prices
-- included (the Products screen, the arrangement board, the day's pricing).
-- PROTECTS AGAINST growers reading selling prices — they get their pick lines'
-- names from get_pick_lines (0086), with no price — and, as before, against
-- customers (who see the catalog only through get_orderable_catalog_for_customer,
-- 0056) and accounts with no profile, for which current_role() is null.
create policy "product_varieties_select_backoffice" on public.product_varieties
  for select
  to authenticated
  using ((select public.current_role()) = 'backoffice');

-- 2. The per-customer pallet cap.
drop table if exists public.product_customer_caps;
