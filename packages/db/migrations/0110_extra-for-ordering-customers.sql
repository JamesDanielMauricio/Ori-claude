-- The office may give a customer who ordered more than they ordered, up to
-- the stock — as it already could a customer who did not order the product
-- (James, 2026-11-21: "Extra for ordering customers too").
--
-- Until now an arrangement was held to two ceilings, both in
-- check_arrangement_allocation: what the grower's line holds (picked +
-- leftover), and — only for a customer who had ordered the product — what
-- that customer ordered. A customer who had not ordered it could be offered
-- any amount through "+" on the board (a zero-pallet order line carries the
-- offer), while one who had ordered 1 could not be given 2. James chose to
-- treat both alike: the line's stock is the only ceiling.
--
-- What changes: check_arrangement_allocation keeps its first ceiling and
-- drops the second. It is shared by create_arrangement_record,
-- update_arrangement_record and arrange_to_customer — and so by the board's
-- boxes, its pencil edits, and the grid's "שמור שינויים"
-- (save_arrangement_changes, through arrange_to_customer) — so the rule moves
-- for all of them at once and cannot drift between them.
--
-- What does not change: the stock ceiling (P0009, OVER_ALLOCATION); a
-- quantity must still be above zero and in tenths (migration 0085); and the
-- grid's "הצע סידור" still SUGGESTS only what was ordered — its suggestions
-- fill orders (apps/web arrangement-engine.ts), while giving more is the
-- office's own choice, typed by hand.
--
-- Rollout: dev by hand first, then live on merge. A replaced function body
-- only; CREATE OR REPLACE keeps the function's permissions. Safe to run again.

create or replace function public.check_arrangement_allocation(
  p_daily_pick_product_id uuid,
  p_daily_order_product_id uuid,
  p_quantity_pallets numeric,
  p_excluding_record_id uuid
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pallets_picked numeric;
  v_leftover_pallets numeric;
  v_supply_arranged numeric;
begin
  if p_quantity_pallets <= 0 then
    raise exception 'INVALID_INPUT: quantity must be positive' using errcode = 'P0008';
  end if;

  select pallets_picked, leftover_pallets into v_pallets_picked, v_leftover_pallets
  from public.daily_pick_products where id = p_daily_pick_product_id;

  select coalesce(sum(quantity_pallets), 0) into v_supply_arranged
  from public.arrangement_records
  where daily_pick_product_id = p_daily_pick_product_id
    and (p_excluding_record_id is null or id <> p_excluding_record_id);

  -- The ceiling is picked + leftover, not picked alone: carried-forward
  -- leftover is real, immediately arrangeable supply on equal footing with a
  -- fresh pick (migration 0050).
  --
  -- The only ceiling (0110). What the customer ordered no longer limits the
  -- arrangement: p_daily_order_product_id is still taken, so the three
  -- callers need not change, but it decides nothing here any more.
  if v_supply_arranged + p_quantity_pallets > v_pallets_picked + coalesce(v_leftover_pallets, 0) then
    raise exception 'OVER_ALLOCATION: % pallets already arranged + % requested exceeds % pallets picked + leftover on this line',
      v_supply_arranged, p_quantity_pallets, v_pallets_picked + coalesce(v_leftover_pallets, 0)
      using errcode = 'P0009';
  end if;
end;
$$;

comment on function public.check_arrangement_allocation(uuid, uuid, numeric, uuid) is
  'Internal. Raises P0009 if arranging p_quantity_pallets would exceed the pick line''s pallets_picked + leftover_pallets (carried-forward leftover counts as real supply), summed against every OTHER arrangement_records row referencing it. Since migration 0110 that is the only ceiling: a customer may receive more than they ordered, up to the stock, whether they ordered the variety or not (James, 2026-11-21). p_daily_order_product_id is accepted but no longer used. Shared by create_arrangement_record, update_arrangement_record and arrange_to_customer so the rule can''t drift between them.';
