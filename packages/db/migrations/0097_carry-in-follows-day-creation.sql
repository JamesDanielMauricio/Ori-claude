-- A new pick line's carried-in leftover now comes from the day before it in
-- the order the trading days were CREATED, not from the latest trade date
-- (James, 2026-11-12).
--
-- Found on the live app on 2026-11-12. bootstrap_grower_pick and
-- sync_grower_picks seeded a new line from this grower+variety's most recent
-- other line by trade_date: any trade_date, including one after the day
-- being filled. The calendar opens a day for any date from today on, so days
-- can be out of date order. Closed test days dated 13.11 and 14.11, created
-- on 9 and 10 November, were still the "most recent" when 12.11 was opened on
-- 12 November, and every grower's 12.11 lines carried in what was left on
-- 14.11 instead of what was left when 11.11 closed.
--
-- Only one trading day can be open at a time, so days are opened and closed
-- one after another: the order they were created in is the order they
-- happened in, whatever date each was given. So a new line now carries in
-- from the most recently created day before the one being filled:
--   - only days created before it count (created_at earlier than its own),
--     so a line can never carry in from a day that came after it;
--   - newest first by created_at; then trade_date, then when the pick was
--     created, so equal times still resolve the same way every time.
--     Imported days keep Bubble's own creation time, so their order holds
--     too.
--
-- Lines that already exist keep their carry-in: this changes how a NEW line
-- is seeded, nothing else. The two bodies are 0070's bootstrap_grower_pick
-- and 0088's sync_grower_picks, unchanged apart from the lines marked
-- "0097". Their grants stand (create or replace keeps them). Safe to run
-- again.

create or replace function public.bootstrap_grower_pick(
  p_trading_day_id uuid,
  p_grower_company_id uuid
)
returns public.daily_picks
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pick public.daily_picks;
  -- 0097: when the day being filled was created. Its new lines carry in from
  -- the days created before it.
  v_day_created_at timestamptz;
begin
  -- SECURITY: ALLOWS a backoffice account to create and re-sync a grower's pick for a day. PROTECTS AGAINST a
  -- grower or customer calling it straight through the API (every signed-in
  -- account may execute it). A caller with no profile at all has a NULL role,
  -- and NULL <> 'backoffice' does not raise; that caller is stopped by
  -- row-level security instead, because this function runs as its caller
  -- (security invoker) and only backoffice may write the pick tables.
  -- Unchanged from 0050.
  if public.current_role() <> 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select created_at into v_day_created_at
  from public.trading_days
  where id = p_trading_day_id;

  insert into public.daily_picks (trading_day_id, grower_company_id)
  values (p_trading_day_id, p_grower_company_id)
  on conflict (trading_day_id, grower_company_id) do nothing;

  select * into v_pick
  from public.daily_picks
  where trading_day_id = p_trading_day_id and grower_company_id = p_grower_company_id;

  -- Upsert: a line already on the pick keeps everything it has
  -- (pallets_picked, leftover_pallets, comment) untouched — `do nothing`, not
  -- `do update`. A genuinely NEW line seeds leftover_pallets from this same
  -- grower+variety's line on the most recently CREATED day before this one
  -- (0097): days are opened and closed one at a time, so creation order is
  -- the order they happened in, whatever date each was given. Ties on the
  -- creation time fall to trade_date, then to when that pick was created, so
  -- they still resolve the same way every time. `dp2.id <> v_pick.id` keeps
  -- this day's own pick out even on a same-day re-run.
  insert into public.daily_pick_products (daily_pick_id, product_variety_id, leftover_pallets)
  select
    v_pick.id,
    gp.product_variety_id,
    coalesce(v_prev.carry_forward, 0)
  from public.grower_products gp
  left join lateral (
    -- 0070: what was LEFT when that day closed is what carries in.
    select coalesce(dpp2.end_of_day_leftover_pallets, dpp2.leftover_pallets) as carry_forward
    from public.daily_pick_products dpp2
    join public.daily_picks dp2 on dp2.id = dpp2.daily_pick_id
    join public.trading_days td2 on td2.id = dp2.trading_day_id
    where dp2.grower_company_id = p_grower_company_id
      and dpp2.product_variety_id = gp.product_variety_id
      and dp2.id <> v_pick.id
      -- 0097: only days created before this one, the latest of them first.
      and td2.created_at < v_day_created_at
    order by td2.created_at desc, td2.trade_date desc, dp2.created_at desc
    limit 1
  ) v_prev on true
  where gp.company_id = p_grower_company_id
  on conflict (daily_pick_id, product_variety_id) do nothing;

  -- Prune: a line whose product fell out of the grower's in-season list is
  -- removed — but only if it's still untouched (nothing picked, nothing left
  -- over from a prior day, nothing arranged). A line with real data of any
  -- kind is left in place rather than cascade-deleted, even though it no
  -- longer matches grower_products.
  delete from public.daily_pick_products dpp
  where dpp.daily_pick_id = v_pick.id
    and not exists (
      select 1 from public.grower_products gp
      where gp.company_id = p_grower_company_id
        and gp.product_variety_id = dpp.product_variety_id
    )
    and dpp.pallets_picked = 0
    and coalesce(dpp.leftover_pallets, 0) = 0
    and not exists (
      select 1 from public.arrangement_records ar
      where ar.daily_pick_product_id = dpp.id
    );

  return v_pick;
end;
$$;

comment on function public.bootstrap_grower_pick(uuid, uuid) is
  'Backoffice-only. Idempotent: creates the grower''s Daily Pick for the day if absent, then upserts its pick-product lines to exactly match grower_products — existing lines (and their pallets_picked/leftover_pallets/comment) are preserved. A newly-created line seeds leftover_pallets from this same grower+variety''s line on the most recently CREATED trading day before this one (end_of_day_leftover_pallets, 0070; creation order, 0097), so unsold stock carries forward in the order the days happened. Lines for now-out-of-season products are pruned ONLY if untouched (pallets_picked = 0, leftover_pallets = 0, and no arrangement_records reference them). Safe to call repeatedly.';

create or replace function public.sync_grower_picks(p_grower_company_id uuid default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_day public.trading_days;
begin
  -- SECURITY: ALLOWS a backoffice account to re-sync pick lines. PROTECTS
  -- AGAINST a grower or customer calling it straight through the API (every
  -- signed-in account may execute it) to add or delete pick lines. A caller
  -- with no profile at all has a NULL role, and NULL <> 'backoffice' does not
  -- raise; that caller is stopped by row-level security instead, because this
  -- function runs as its caller (security invoker) and only backoffice may
  -- write daily_picks and daily_pick_products. Unchanged from 0050.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select * into v_day from public.trading_days where phase <> 'closed' for update;
  if not found then
    return;
  end if;

  -- 0088: an inactive grower's pick for the open day is deleted, with its
  -- lines and whatever was arranged from them (James, 2026-11-09: "delete
  -- their data"). Only this day: closed days keep their history. Made active
  -- again, the grower gets a new pick from the insert just below, its lines
  -- carrying in the leftovers of its last closed day, as for any new pick.
  delete from public.daily_picks dp
  using public.companies c
  where dp.trading_day_id = v_day.id
    and dp.grower_company_id = c.id
    and c.status = 'inactive'
    and (p_grower_company_id is null or c.id = p_grower_company_id);

  insert into public.daily_picks (trading_day_id, grower_company_id)
  select v_day.id, c.id
  from public.companies c
  where c.type = 'grower'
    and c.status = 'active'
    and (p_grower_company_id is null or c.id = p_grower_company_id)
    and exists (select 1 from public.grower_products gp where gp.company_id = c.id)
    and not exists (
      select 1 from public.daily_picks dp
      where dp.trading_day_id = v_day.id and dp.grower_company_id = c.id
    );

  -- Drop pick lines for varieties no longer in the grower's in-season list —
  -- but only a line with nothing on it. One the grower has picked pallets on,
  -- one still carrying leftover stock, or one already referenced by an
  -- arrangement record is left alone rather than deleted (or cascade-deleted).
  delete from public.daily_pick_products dpp
  using public.daily_picks dp
  where dpp.daily_pick_id = dp.id
    and dp.trading_day_id = v_day.id
    and (p_grower_company_id is null or dp.grower_company_id = p_grower_company_id)
    and not exists (
      select 1 from public.grower_products gp
      where gp.company_id = dp.grower_company_id
        and gp.product_variety_id = dpp.product_variety_id
    )
    -- 0067: picked pallets are stock too — the condition 0037 and 0050 missed.
    and dpp.pallets_picked = 0
    and coalesce(dpp.leftover_pallets, 0) = 0
    and not exists (
      select 1 from public.arrangement_records ar where ar.daily_pick_product_id = dpp.id
    );

  -- Add lines for newly in-season varieties. Existing lines — and the
  -- pallets_picked/leftover_pallets already on them — are untouched. A
  -- genuinely new line seeds leftover_pallets the same way
  -- bootstrap_grower_pick does: from this grower+variety's line on the most
  -- recently created day before the open one (0097).
  insert into public.daily_pick_products (daily_pick_id, product_variety_id, leftover_pallets)
  select
    dp.id,
    gp.product_variety_id,
    coalesce(v_prev.carry_forward, 0)
  from public.daily_picks dp
  join public.grower_products gp on gp.company_id = dp.grower_company_id
  left join lateral (
    -- 0070: what was LEFT when that day closed is what carries in.
    select coalesce(dpp2.end_of_day_leftover_pallets, dpp2.leftover_pallets) as carry_forward
    from public.daily_pick_products dpp2
    join public.daily_picks dp2 on dp2.id = dpp2.daily_pick_id
    join public.trading_days td2 on td2.id = dp2.trading_day_id
    where dp2.grower_company_id = dp.grower_company_id
      and dpp2.product_variety_id = gp.product_variety_id
      and dp2.id <> dp.id
      -- 0097: only days created before the open one, the latest of them first.
      and td2.created_at < v_day.created_at
    order by td2.created_at desc, td2.trade_date desc, dp2.created_at desc
    limit 1
  ) v_prev on true
  where dp.trading_day_id = v_day.id
    and (p_grower_company_id is null or dp.grower_company_id = p_grower_company_id)
    and not exists (
      select 1 from public.daily_pick_products dpp
      where dpp.daily_pick_id = dp.id and dpp.product_variety_id = gp.product_variety_id
    );
end;
$$;

comment on function public.sync_grower_picks(uuid) is
  'Backoffice-only. Reconciles the open (non-closed) trading day''s picks with the growers: an inactive grower''s pick for that day is deleted with its lines and their arrangement records (migration 0088); an active grower with products and no pick gets one; lines for varieties out of the grower''s in-season list are pruned only when untouched; newly in-season varieties get lines seeding leftover_pallets from the grower''s line on the most recently created day before the open one (0070, 0097). p_grower_company_id null = every grower. No-op when no day is open.';
