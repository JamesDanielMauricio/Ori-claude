-- 0105 — the grower sets the day's pickup time.
--
-- In Bubble a grower can change the day's pickup time on their own picking
-- screen, until the pick is closed. Ori only ever copied the company's default
-- onto the pick when it was sent (submit_pick, 0043). Looking back, the 1851
-- picks since August 2026 each kept one time, but James wants the feature, so
-- it comes back. Two changes:
--   1. set_pick_pickup_time(pick, time) — the grower's one checked way to write
--      daily_picks.pickup_time. Backoffice may use it too.
--   2. submit_pick keeps a time the grower already chose. A draft pick only has
--      a time if its grower chose one (it is empty until sent), so everyone who
--      never chose still gets the company default snapshot, exactly as before.
--
-- The transporter's message (queue_grower_sale_messages, 0081) already reads
-- daily_picks.pickup_time first and the company default second, so it names the
-- grower's chosen time with no change here.
--
-- Run this BEFORE the web deploy. Today's site keeps working with it applied:
-- submit_pick(uuid) has the same signature and, for a grower who never chose a
-- time, the same result. Safe to run again: every function is
-- "create or replace" and the grants can be repeated.

-- 1. The grower sets the time.
--
-- SECURITY: security definer, so the function writes daily_picks as its owner.
-- That is needed because a grower can only READ daily_picks (they have no
-- update policy on it, so a direct write is filtered by row-level security);
-- this function is their one checked way to write the pickup time and nothing
-- else on the pick.
create or replace function public.set_pick_pickup_time(p_daily_pick_id uuid, p_pickup_time time)
returns public.daily_picks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pick public.daily_picks;
  v_phase public.trading_day_phase;
begin
  -- Lock the pick so a truck press (closing it) and this write cannot cross.
  select * into v_pick from public.daily_picks where id = p_daily_pick_id for update;
  if not found then
    raise exception 'NOT_FOUND: pick % does not exist', p_daily_pick_id using errcode = 'P0002';
  end if;

  -- SECURITY (0076 pattern, fail closed): ALLOWS a backoffice account, or a
  -- grower account of the grower company this pick belongs to. PROTECTS AGAINST
  -- every other caller: another grower, a customer, a signed-in account with no
  -- profile, and a caller who is not signed in at all. `is distinct from`
  -- counts a NULL role or company as a mismatch, so a missing profile is
  -- refused rather than waved through, and the role must really be 'grower',
  -- not merely an account whose company happens to match.
  if public.current_role() is distinct from 'backoffice'
     and (public.current_role() is distinct from 'grower'
          or v_pick.grower_company_id is distinct from public.current_company_id()) then
    raise exception 'FORBIDDEN: not this pick''s grower' using errcode = '42501';
  end if;

  if p_pickup_time is null then
    raise exception 'INVALID_INPUT: pickup time is required' using errcode = 'P0008';
  end if;

  -- Same text and code as save_pick_lines, so the web already shows its Hebrew
  -- message. A closed pick is final; so is any pick of a finished day.
  if v_pick.status = 'closed' then
    raise exception 'INVALID_STATE: this pick is closed — no further edits are permitted' using errcode = 'P0007';
  end if;
  select phase into v_phase from public.trading_days where id = v_pick.trading_day_id;
  if v_phase = 'closed' then
    raise exception 'INVALID_STATE: this pick is closed — no further edits are permitted' using errcode = 'P0007';
  end if;

  update public.daily_picks
  set pickup_time = p_pickup_time, updated_at = now()
  where id = p_daily_pick_id
  returning * into v_pick;

  return v_pick;
end;
$$;

comment on function public.set_pick_pickup_time(uuid, time) is
  'Sets the day''s pickup time on one pick. Allowed for backoffice and for the grower of that pick; refused once the pick is closed or its trading day has ended. Works on a draft and on a sent pick. Migration 0105.';

-- SECURITY: ALLOWS signed-in accounts (and the service role) to call it; the
-- function itself then lets only backoffice and the pick's own grower through.
-- PROTECTS AGAINST a visitor who is not signed in: functions get EXECUTE for
-- PUBLIC by default and Supabase's default privileges add `anon`, so both are
-- revoked and a signed-out call stops at "permission denied" before running.
revoke all on function public.set_pick_pickup_time(uuid, time) from public, anon;
grant execute on function public.set_pick_pickup_time(uuid, time) to authenticated, service_role;

-- 2. Sending keeps a chosen time.
--
-- 0076's body unchanged except the pickup_time line. SECURITY: unchanged from
-- 0076 — security definer, with the same fail-closed check allowing backoffice
-- or the pick's own grower and refusing everyone else. Its grants are kept
-- when a function is replaced, so none are repeated here.
create or replace function public.submit_pick(p_daily_pick_id uuid)
returns public.daily_picks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pick public.daily_picks;
  v_pickup_time time;
begin
  select * into v_pick from public.daily_picks where id = p_daily_pick_id for update;
  if not found then
    raise exception 'NOT_FOUND: pick % does not exist', p_daily_pick_id using errcode = 'P0002';
  end if;

  -- SECURITY (0076): ALLOWS a backoffice account, or a grower account of the
  -- grower company this pick belongs to. PROTECTS AGAINST every other caller:
  -- another grower, a customer, a signed-in account with no profile, and a
  -- caller who is not signed in at all. The old check (role <> 'backoffice'
  -- and company <> own company) never refused when the role or company was
  -- NULL — exactly the no-profile and signed-out cases. `is distinct from`
  -- counts NULL as a mismatch, and the role must now really be 'grower', not
  -- merely an account whose company happens to match.
  if public.current_role() is distinct from 'backoffice'
     and (public.current_role() is distinct from 'grower'
          or v_pick.grower_company_id is distinct from public.current_company_id()) then
    raise exception 'FORBIDDEN: not this pick''s grower' using errcode = '42501';
  end if;

  if v_pick.status <> 'draft' then
    raise exception 'INVALID_STATE: pick % is % — can only submit from draft', p_daily_pick_id, v_pick.status
      using errcode = 'P0007';
  end if;

  select default_pickup_time into v_pickup_time
  from public.companies
  where id = v_pick.grower_company_id;

  -- 0105: a draft only has a time if its grower chose one (set_pick_pickup_time),
  -- so that choice wins; everyone else keeps 0043's snapshot of the company
  -- default.
  update public.daily_picks
  set status = 'submitted', submitted_at = now(),
      pickup_time = coalesce(v_pick.pickup_time, v_pickup_time),
      updated_at = now()
  where id = p_daily_pick_id
  returning * into v_pick;

  return v_pick;
end;
$$;

-- 3. Two descriptions written by 0043 stopped being true with this migration,
-- so they are rewritten here (this file is not applied anywhere yet; 0043
-- itself is never edited).
comment on column public.daily_picks.pickup_time is
  'The day''s pickup time for this pick. The grower (or backoffice) may set it at any time until the pick is closed, with set_pick_pickup_time (migration 0105) — on a draft as well as on a sent pick. If nobody has set one, submit_pick records the grower company''s default_pickup_time when the pick is sent (migration 0043), and ending the day does the same for a pick that was never sent, so a later change to the default cannot rewrite this day. Sending a pick back to draft clears the time. Null only while a draft has no time chosen; the UI reads the live company default until then.';

comment on function public.submit_pick(uuid) is
  'The owning grower (or backoffice). Draft -> Submitted on a Daily Pick. Keeps the pickup time already set on the pick (set_pick_pickup_time, migration 0105); only when none is set does it record the grower company''s current default_pickup_time, so a later edit to the default cannot rewrite this day''s record. security definer: RLS grants growers no general write on daily_picks, so this function is the sole path, checking ownership and forward-only status itself. Raises 42501 for anyone but backoffice or this pick''s grower, and P0007 if the pick is not currently in draft.';
