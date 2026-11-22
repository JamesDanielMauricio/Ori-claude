-- Limits the database itself holds picks and orders to.
--
-- Found in testing (2026-11-20, again on 2026-11-21): the screens refuse a
-- half pallet, but a grower calling the database directly — not through any
-- screen — could still save a pick of 4.5 pallets, of 99,999,999 pallets, or
-- with a 10,000-character comment. save_pick_lines checked only that numbers
-- were not negative. These rules sit on the tables themselves, so they hold
-- however a row is written: the RPCs, the office's direct writes, imports.
-- The one exception is a leftover, held to its limits only when someone
-- changes it — never when a day carries it over (see "leftovers" below).
-- The screens check the same numbers first (packages/shared/src/limits.ts),
-- so a person is told in Hebrew before anything is sent;
-- packages/db/src/limits-match.test.ts keeps the two in step.
--
-- Every number was checked against live first (read-only, 2026-11-21, 83,339
-- pick lines): the largest pick is 128 pallets, the largest leftover 42, the
-- largest order line 1,111, the longest comment 72 characters; no pick,
-- leftover, order or arrangement holds a fraction. Every stored row passes
-- every rule below, so adding them changes nothing that is there.
--
-- Rollout: dev by hand first, then live on merge. Adding a CHECK reads the
-- table once, under a short lock, to confirm every stored row passes; if one
-- did not, the migration would stop and change nothing. Safe to run again.

-- ---------------------------------------------------------------- pick lines

alter table public.daily_pick_products
  drop constraint if exists daily_pick_products_pallets_picked_whole,
  drop constraint if exists daily_pick_products_pallets_picked_range,
  drop constraint if exists daily_pick_products_comment_length;

alter table public.daily_pick_products
  -- RULE: ALLOWS a pick of whole pallets only — 0, 1, 2… PROTECTS AGAINST a
  -- pick of 4.5 pallets: picks stay whole until the client decides otherwise
  -- (decision D18), as every screen that enters one already requires.
  add constraint daily_pick_products_pallets_picked_whole
    check (pallets_picked = trunc(pallets_picked)),
  -- RULE: ALLOWS 0 to 9,999 pallets picked on one line in one day.
  -- PROTECTS AGAINST a mistyped or deliberate huge number (99,999,999) that
  -- would become stock the office could arrange and sell. 9,999 is 78 times
  -- the largest real pick.
  add constraint daily_pick_products_pallets_picked_range
    check (pallets_picked >= 0 and pallets_picked <= 9999),
  -- RULE: ALLOWS a comment of up to 500 characters (or none). PROTECTS
  -- AGAINST a 10,000-character comment that every screen showing the pick —
  -- and every message quoting it — would have to carry.
  add constraint daily_pick_products_comment_length
    check (char_length(comment) <= 500);

-- ----------------------------------------------------------------- leftovers
--
-- A leftover is held to its limits when someone CHANGES it — by a trigger,
-- not a CHECK. A CHECK would also hold the number that opening a day writes:
-- each new day's line starts with the last day's picked + leftover − arranged
-- (bootstrap_grower_pick inserts it), and that sum can pass any limit — a
-- leftover of 99,999 and 9 picked, with nothing sold, carries 100,008 into
-- the next day. A CHECK would refuse that insert, and with it the opening of
-- the whole day, for everyone. So what a day carries over is never refused;
-- it can only grow by real picks, of at most 9,999 a day.

create or replace function public.refuse_leftover_out_of_range()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- RULE: ALLOWS a leftover someone changes — a grower on their own pick,
  -- the office through the board's stock edit or straight to the table — to
  -- be 0 to 99,999 pallets with at most one decimal place, and ALLOWS every
  -- save that leaves the leftover as it was. PROTECTS AGAINST a huge
  -- leftover (99,999,999) sent straight to the database: stock the office
  -- could arrange and sell, and an end-of-day sum (picked + leftover −
  -- arranged) too big for its column, so the day could not close. Also
  -- against a negative leftover, or one finer than a tenth. A tenth is
  -- allowed because a leftover is not always whole: arrangements may be in
  -- tenths (workbook Task 35, migration 0085), so what a day carries over
  -- can be 2.5.
  if new.leftover_pallets is distinct from old.leftover_pallets
     and (new.leftover_pallets < 0
          or new.leftover_pallets > 99999
          or new.leftover_pallets <> trunc(new.leftover_pallets, 1)) then
    -- Coded (23514) and worded as Postgres words a CHECK's refusal, so every
    -- caller reads it like the CHECKs in this file.
    raise exception 'new row for relation "daily_pick_products" violates check constraint "daily_pick_products_leftover_range"'
      using errcode = '23514', constraint = 'daily_pick_products_leftover_range',
            table = 'daily_pick_products', schema = 'public';
  end if;
  return new;
end;
$$;

comment on function public.refuse_leftover_out_of_range() is
  'Trigger (0109). Refuses (23514, as daily_pick_products_leftover_range) a pick line''s leftover_pallets changed to below 0, above 99,999, or with more than one decimal place. Only a change is checked: the leftover a line is created with when a day opens (carried over from the last day) never is.';

-- SECURITY: ALLOWS no one to call it directly; it only runs as the trigger
-- below. PROTECTS AGAINST it being reached as an API function.
revoke execute on function public.refuse_leftover_out_of_range() from public, anon, authenticated, service_role;

-- On an UPDATE that sets leftover_pallets, never on an INSERT. Pick lines
-- are inserted when a day opens, carrying the last day's leftover in; no
-- screen inserts one, and a grower cannot insert one at all (row-level
-- security lets only the office write this table directly).
drop trigger if exists daily_pick_products_leftover_range on public.daily_pick_products;
create trigger daily_pick_products_leftover_range
  before update of leftover_pallets on public.daily_pick_products
  for each row
  execute function public.refuse_leftover_out_of_range();

-- --------------------------------------------------------------- order lines

alter table public.daily_order_products
  drop constraint if exists daily_order_products_pallets_ordered_range,
  drop constraint if exists daily_order_products_comment_length;

alter table public.daily_order_products
  -- RULE: ALLOWS 0 to 9,999 pallets on one order line. PROTECTS AGAINST a
  -- huge number on the one path no stock limit covers: staff ordering on a
  -- customer's behalf (בשם לקוח) may go past the stock on purpose, and a
  -- customer's own order is already held to the stock by submit_order. The
  -- largest real line is 1,111.
  add constraint daily_order_products_pallets_ordered_range
    check (pallets_ordered >= 0 and pallets_ordered <= 9999),
  -- RULE: ALLOWS a line comment of up to 500 characters (or none).
  -- PROTECTS AGAINST a customer sending a 10,000-character comment straight
  -- to the database, which every order screen and message would carry.
  add constraint daily_order_products_comment_length
    check (char_length(comment) <= 500);

-- -------------------------------------------------------- the order's comment

alter table public.daily_orders
  drop constraint if exists daily_orders_comment_length;

-- RULE: ALLOWS the comment on a whole order ("הערה כללית", migration 0093)
-- to be up to 500 characters (or none). PROTECTS AGAINST the same oversized
-- comment as on a line.
alter table public.daily_orders
  add constraint daily_orders_comment_length
    check (char_length(comment) <= 500);
