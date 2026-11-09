-- Workbook Tasks 30 (item 3) and 32 (item 5) — what making a company inactive
-- does. James (2026-11-09):
--   - an inactive company's users lose access, and its messages stop;
--   - an inactive grower's data for the open day is deleted (a grower made
--     active again during the day gets its pick back: save_grower already
--     calls sync_grower_picks, which creates the pick of an active grower
--     that has none, carrying in its leftovers — unchanged here).
--
-- 1. Access. current_role() and current_company_id() — which every security
--    rule and privileged function asks "who is calling, and for which
--    company?" — return nothing for a user whose company is inactive. Every
--    rule and function already refuses a caller with no role or company
--    (0076), so such a user can sign in but read or change nothing. Their own
--    profile row stays readable (that rule checks the user id, not the role),
--    which is how the app tells them why. Staff (backoffice) are never cut
--    off this way, whatever their company: making the office's own company
--    inactive must not lock everyone out of the system.
-- 2. my_account_is_active(): lets the app ask, at sign-in, whether the
--    signed-in user's company is active, so it can sign them out with a
--    message instead of showing empty screens.
-- 3. Messages. A WhatsApp message queued for an inactive company is marked
--    skipped the moment it is queued, with the reason; and when a company is
--    made inactive, its messages still waiting to go out are skipped the same
--    way. Skipped messages show on the WhatsApp messages screen and are never
--    sent, even if the company is made active again later.
-- 4. The open day. sync_grower_picks — run by every grower save and by the
--    "עדכון מלאי למגדלים" button — now also deletes an inactive grower's pick
--    for the day that is not closed, with its lines and whatever was arranged
--    from them. Earlier days are never touched. Its body is 0070's, apart from
--    the block marked "0088" and the role check, which uses `is distinct from`.
--
-- Rollout: run before pushing the web app; the app deployed today keeps
-- working (its users' companies are active). Safe to run again.

-- 1. Who is calling, and for which company — nothing for an inactive company.
--
-- SECURITY: ALLOWS a signed-in user whose company is active (or who has no
-- company), and every staff member, to be recognised as before. PROTECTS
-- AGAINST a user of an inactive company reading or changing anything: every
-- row-level security rule and privileged function asks these two functions,
-- and refuses a caller for whom they return nothing. Staff are exempt so that
-- a mistaken change to the office's own company cannot lock the office out.
-- Security definer (as before) so they can read the caller's profile and
-- company whatever those tables' own rules allow.
create or replace function public.current_role()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select p.role
  from public.profiles p
  left join public.companies c on c.id = p.company_id
  where p.user_id = (select auth.uid())
    and (p.role = 'backoffice' or c.status is distinct from 'inactive')
$$;

comment on function public.current_role() is
  'The calling user''s profiles.role, looked up via auth.uid() — or NULL when that user''s company is inactive (migration 0088; backoffice excepted). Use inside RLS policies that need to distinguish backoffice from grower/customer. Schema-qualify as public.current_role() — do not confuse with the built-in CURRENT_ROLE keyword, which returns the Postgres session role instead.';

create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.company_id
  from public.profiles p
  left join public.companies c on c.id = p.company_id
  where p.user_id = (select auth.uid())
    and (p.role = 'backoffice' or c.status is distinct from 'inactive')
$$;

comment on function public.current_company_id() is
  'The calling user''s profiles.company_id, looked up via auth.uid() — or NULL when that company is inactive (migration 0088; backoffice excepted). Used by RLS policies and privileged functions to scope a caller to their own company.';

-- 2. Is the signed-in user's account usable?
--
-- SECURITY: ALLOWS any signed-in user to learn one thing about their own
-- account — whether their company is active (staff: always). PROTECTS AGAINST
-- revealing anything about anyone else: it takes no argument and reads only
-- the caller's own profile and company. Anonymous callers cannot run it.
create or replace function public.my_account_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p.role = 'backoffice' or c.status is distinct from 'inactive'
  from public.profiles p
  left join public.companies c on c.id = p.company_id
  where p.user_id = (select auth.uid())
$$;

comment on function public.my_account_is_active() is
  'True when the signed-in user may use the app: staff always, anyone else while their company is not inactive (migration 0088). NULL for an account with no profile. The app signs a user out, with a message, when this is false.';

revoke execute on function public.my_account_is_active() from public, anon;
grant execute on function public.my_account_is_active() to authenticated;

-- 3. Messages for an inactive company are skipped.
--
-- SECURITY: not a permission check — it keeps messages from going out. ALLOWS
-- every message to an active company to be queued as before. PROTECTS AGAINST
-- an inactive company receiving WhatsApp messages: a message queued for one
-- is marked skipped at once, so the sender never picks it up. Security
-- definer so it can read the company whatever the queueing caller may read;
-- it changes only the row being inserted.
create or replace function public.skip_messages_for_inactive_companies()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.skipped_at is null
     and new.sent_at is null
     and exists (
       select 1 from public.companies c
       where c.id = new.recipient_company_id and c.status = 'inactive'
     ) then
    new.skipped_at := now();
    new.last_error := 'Skipped: the company is inactive';
  end if;
  return new;
end;
$$;

revoke execute on function public.skip_messages_for_inactive_companies() from public, anon, authenticated, service_role;

drop trigger if exists notification_outbox_skip_inactive_companies on public.notification_outbox;
create trigger notification_outbox_skip_inactive_companies
  before insert on public.notification_outbox
  for each row
  execute function public.skip_messages_for_inactive_companies();

-- SECURITY: not a permission check — it keeps messages from going out. ALLOWS
-- a company to be made inactive as before. PROTECTS AGAINST the messages it
-- had waiting going out after it was made inactive: they are marked skipped,
-- with the reason. Messages already sent or skipped are left as they are.
-- Security definer: the staff member saving the company may not be able to
-- update the message queue directly.
create or replace function public.skip_waiting_messages_of_inactive_company()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'inactive' and old.status is distinct from 'inactive' then
    update public.notification_outbox
    set skipped_at = now(),
        last_error = 'Skipped: the company is inactive'
    where recipient_company_id = new.id
      and sent_at is null
      and skipped_at is null;
  end if;
  return new;
end;
$$;

revoke execute on function public.skip_waiting_messages_of_inactive_company() from public, anon, authenticated, service_role;

drop trigger if exists companies_skip_waiting_messages_when_inactive on public.companies;
create trigger companies_skip_waiting_messages_when_inactive
  after update of status on public.companies
  for each row
  execute function public.skip_waiting_messages_of_inactive_company();

-- 4. The open day: an inactive grower has no pick.
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
  -- bootstrap_grower_pick does: from this grower+variety's most recent
  -- OTHER line.
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
    order by td2.trade_date desc, dp2.created_at desc
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
  'Backoffice-only. Reconciles the open (non-closed) trading day''s picks with the growers: an inactive grower''s pick for that day is deleted with its lines and their arrangement records (migration 0088); an active grower with products and no pick gets one; lines for varieties out of the grower''s in-season list are pruned only when untouched; newly in-season varieties get lines seeding leftover_pallets from the grower''s most recent other line (0070). p_grower_company_id null = every grower. No-op when no day is open.';
