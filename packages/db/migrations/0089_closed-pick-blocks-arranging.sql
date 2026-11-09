-- Workbook Task 32 (item 2) — a closed pick blocks arranging.
--
-- Closing a grower's pick (the truck icon, set_pick_closed) marks the grower
-- done for the day and, since 0081, sends the grower and its transporter
-- their sale and pickup messages. Arranging could still change afterwards,
-- so those messages could describe an arrangement that no longer held.
-- James (2026-11-09): a closed pick blocks arranging. To change what was
-- arranged from it, reopen the pick (the truck icon again), which also lets
-- the next completion send an up-to-date message (0081).
--
-- A save made through the app (by a signed-in user) is refused when it adds
-- an allocation to, changes the pallets of, or removes an allocation from a
-- line of a closed pick. One trigger on arrangement_records, so every writer
-- — the board's ✓ (arrange_to_customer), the records table, the grid, "הצע
-- סידור" (save_arrangement_proposal) and a delete — is covered without
-- restating any of them. Not refused:
--   - a price change on an allocation (the day's end prices every record, and
--     staff may correct a price): only the pallets, the pick line and the
--     order line count as arranging;
--   - the importer and migrations, which run as the database owner;
--   - allocations removed because their pick itself is being deleted (a
--     discarded day, a grower made inactive — 0088): by then the pick is
--     gone, so there is no closed pick to protect.
-- The refusal has its own code, P0010, and a Hebrew message the screens show
-- as it is.
--
-- Rollout: run before pushing the web app; the app deployed today keeps
-- working, and shows the refusal's message if someone arranges from a closed
-- pick. Safe to run again.

-- SECURITY: a check on saves made through the app. ALLOWS arranging from any
-- pick that is not closed, and changing an allocation's price at any time.
-- PROTECTS AGAINST the arrangement of a grower whose pick is closed changing
-- behind the messages already sent for it — from any screen, or from a request
-- sent straight to the API. Only saves by a signed-in user are checked
-- (auth.uid() is set): the Bubble importer and migrations run as the database
-- owner, so importing closed days cannot fail. Security definer so the pick's
-- status can be read whatever the caller may read; it reads one pick row.
create or replace function public.refuse_arranging_a_closed_pick()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lines uuid[];
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    v_lines := array[new.daily_pick_product_id];
  elsif tg_op = 'DELETE' then
    v_lines := array[old.daily_pick_product_id];
  else
    -- A save that sends the pallets back unchanged (the records table saves
    -- a price that way) is not arranging.
    if new.quantity_pallets is not distinct from old.quantity_pallets
       and new.daily_pick_product_id is not distinct from old.daily_pick_product_id
       and new.daily_order_product_id is not distinct from old.daily_order_product_id then
      return new;
    end if;
    v_lines := array[old.daily_pick_product_id, new.daily_pick_product_id];
  end if;
  if exists (
    select 1
    from public.daily_pick_products dpp
    join public.daily_picks dp on dp.id = dpp.daily_pick_id
    where dpp.id = any (v_lines)
      and dp.status = 'closed'
  ) then
    raise exception 'הליקוט של המגדל סגור (סמל המשאית). כדי לשנות את הסידור שלו, פתחו את הליקוט מחדש.'
      using errcode = 'P0010';
  end if;
  return coalesce(new, old);
end;
$$;

comment on function public.refuse_arranging_a_closed_pick() is
  'Trigger (migration 0089). Refuses (P0010) adding, re-sizing or removing an arrangement record of a closed pick, on saves by a signed-in user. Price changes, the importer and cascaded deletes are not refused.';

-- SECURITY: ALLOWS no one to call it directly; it only runs as the trigger
-- below. PROTECTS AGAINST it being reached as an API function.
revoke execute on function public.refuse_arranging_a_closed_pick() from public, anon, authenticated, service_role;

drop trigger if exists arrangement_records_refuse_closed_pick on public.arrangement_records;
create trigger arrangement_records_refuse_closed_pick
  before insert or update of quantity_pallets, daily_pick_product_id, daily_order_product_id or delete
  on public.arrangement_records
  for each row
  execute function public.refuse_arranging_a_closed_pick();
