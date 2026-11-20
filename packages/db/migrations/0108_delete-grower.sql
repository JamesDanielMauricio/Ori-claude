-- delete_grower: a grower that never traded can be deleted, even while a day
-- is open — the same rule delete_customer (0098) gave customers (James,
-- 2026-11-12).
--
-- A grower added, or made active again, while a trading day is open gets that
-- day's pick straight away, so it can enter its stock (save_grower calls
-- sync_grower_picks, 0037): an empty pick header, with one empty line per
-- product in season. That is
-- right, and it stays. But the pick names the company and its foreign key
-- does not cascade, so the Growers screen refused to delete a grower that had
-- never picked anything ("הרשומה כבר בשימוש"). Found in testing on
-- 2026-11-20; the only way out was to make it inactive first (which drops
-- that day's pick, 0088) and then delete it.
--
-- What now goes with the grower:
--   - its picks that were never used: never sent (no submitted_at, not
--     'submitted'), and not one line holding pallets, leftover pallets, a
--     comment, or an arrangement. Their lines go with them (that foreign key
--     cascades). Those are the empty picks above, and the ones the end of the
--     day closed without anything in them;
--   - the messages addressed to it in notification_outbox.
-- Anything else that still names the grower (a pick with stock, a sent pick,
-- a user) makes the final delete fail with 23503. The whole call then rolls
-- back, the deletes above included, and the screen says what it always said:
-- in use, make it inactive instead. Real history is never deleted, only the
-- leftovers of a grower that never traded. Its in-season product list
-- (grower_products) goes with the company, as it always did (that key
-- cascades).
--
-- An RPC, like delete_customer, rather than the screen's plain delete: one
-- call site for the backoffice check, and the three deletes in one
-- transaction. security invoker: backoffice already writes all three tables
-- under its own row-level security (daily_picks_write_backoffice,
-- notification_outbox_backoffice, and the companies policies the screen's
-- delete used).
--
-- Rollout: a new function only — nothing existing changes. Safe to run again.

create or replace function public.delete_grower(p_grower_company_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- `is distinct from`, not `<>`: a caller with no profile has a NULL role,
  -- and NULL <> 'backoffice' is not true. Row-level security would still
  -- refuse the deletes below; this refuses the call by name first.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.companies
    where id = p_grower_company_id and type = 'grower'
  ) then
    raise exception 'NOT_FOUND: grower company % does not exist', p_grower_company_id using errcode = 'P0002';
  end if;

  -- Picks never used: never sent, and no line with stock, a comment or an
  -- arrangement.
  delete from public.daily_picks p
  where p.grower_company_id = p_grower_company_id
    and p.submitted_at is null
    and p.status <> 'submitted'
    and not exists (
      select 1 from public.daily_pick_products l
      where l.daily_pick_id = p.id
        and (l.pallets_picked > 0 or l.leftover_pallets > 0 or nullif(btrim(l.comment), '') is not null)
    )
    and not exists (
      select 1 from public.arrangement_records r
      join public.daily_pick_products l on l.id = r.daily_pick_product_id
      where l.daily_pick_id = p.id
    );

  delete from public.notification_outbox
  where recipient_company_id = p_grower_company_id;

  -- Fails with 23503 if anything else still names the grower, and the whole
  -- call rolls back with it.
  delete from public.companies where id = p_grower_company_id;
end;
$$;

comment on function public.delete_grower(uuid) is
  'Backoffice-only. Deletes a grower company together with its picks that were never used (never sent; no line with pallets, leftover, a comment or an arrangement) and the messages addressed to it. A grower with anything else (a pick with stock, a sent pick, a user) is refused with 23503 and nothing is deleted. Raises 42501 for a non-backoffice caller, P0002 if the company does not exist or is not a grower.';

-- SECURITY: ALLOWS signed-in users (`authenticated`) and the service role to
-- call it; the function then refuses everyone but backoffice, and being
-- SECURITY INVOKER it deletes through the caller's own row-level security.
-- PROTECTS AGAINST anonymous callers reaching it at all: Postgres grants
-- EXECUTE on every new function to PUBLIC, and Supabase's default privileges
-- add `anon`, so both are revoked here (as for delete_customer, 0098).
revoke execute on function public.delete_grower(uuid) from public, anon;
grant execute on function public.delete_grower(uuid) to authenticated, service_role;
