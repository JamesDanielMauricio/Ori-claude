-- Privileged functions refuse callers with no profile and callers who are
-- not signed in (release workbook task 02, ORI-001).
--
-- Eight functions run as SECURITY DEFINER — with the database owner's rights,
-- past every row-level security rule — and decide for themselves who may use
-- them, by comparing public.current_role() with `<>`. current_role() is NULL
-- for a signed-in account that has no profiles row, and for a request with no
-- sign-in at all (the anon key, which ships inside the app). A comparison with
-- NULL is never true, so every one of those checks let both callers through.
-- Reproduced on a full copy of the schema (every migration through 0075): with
-- nothing but the public anon key and a record's id, a caller could
--   - change a grower's pallet numbers and comments (save_pick_lines,
--     update_pick_product_pallets, update_pick_product_details),
--   - send or reopen a grower's pick (submit_pick, revert_pick_to_draft),
--   - send an order on behalf of any customer (submit_order with
--     p_customer_company_id),
--   - create alerts for any user (create_alert, build_arrangement_alerts).
-- A signed-in account with no profile could do the same (its order on someone
-- else's behalf failed only by luck, on a foreign key). Growers, customers and
-- backoffice users WITH a profile were always checked correctly. Every other
-- function is SECURITY INVOKER, so row-level security already stops both
-- callers there, and every table's write rule requires the backoffice role —
-- both were checked the same way and are clean.
--
-- What changes:
--   1. The eight checks use `is distinct from` (NULL counts as "no"), and the
--      four grower checks also require the grower role, not just a matching
--      company. Each body below is otherwise copied unchanged from the
--      migration that last defined it: 0024 (create_alert), 0035
--      (build_arrangement_alerts), 0043 (submit_pick,
--      update_pick_product_details), 0044 (revert_pick_to_draft), 0050
--      (save_pick_lines, update_pick_product_pallets) and 0072 (submit_order).
--   2. Callers who are not signed in can no longer call those eight at all
--      (EXECUTE revoked from PUBLIC and anon). Signed-in users and the service
--      role keep it.
--   3. max_orderable_for_customer and shop_variety_orderability — internal stock
--      helpers that only the shop catalog and submit_order call — can no
--      longer be called through the API by anyone. They have no caller check
--      and answered anyone, signed in or not, with any customer's stock limit.
--      Their two callers are SECURITY DEFINER functions owned by postgres, so
--      those keep calling them exactly as before.
--
-- Nothing the app does changes: every screen calls these eight as a signed-in
-- grower, customer or backoffice user, and no screen calls the two helpers
-- directly. No app deploy is needed before or after. Safe to run more than
-- once.

create or replace function public.build_arrangement_alerts(p_trading_day_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_count integer;
  v_grower_count integer;
  v_customer_alert_type_id constant uuid := '00000000-0000-0000-0000-000000000001';
  v_grower_alert_type_id constant uuid := '00000000-0000-0000-0000-000000000002';
begin
  -- SECURITY (0076): ALLOWS only a signed-in backoffice account.
  -- PROTECTS AGAINST every other caller — including a signed-in account with
  -- no profile and a caller who is not signed in at all. Both have a NULL
  -- role, and the old `<>` comparison is never true for NULL, so it let them
  -- through; `is distinct from` counts NULL as "not backoffice" and refuses.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  insert into public.alerts (
    intended_for_user_id, alert_type_id, display_record_id,
    number_for_display, send_as_whatsapp, send_as_notification
  )
  select
    p.user_id, v_customer_alert_type_id, p_trading_day_id,
    totals.pallets, at.send_as_whatsapp_default, at.send_as_notification_default
  from (
    select ar.customer_company_id, sum(ar.quantity_pallets) as pallets
    from public.arrangement_records ar
    join public.daily_order_products dop on dop.id = ar.daily_order_product_id
    join public.daily_orders do2 on do2.id = dop.daily_order_id
    where do2.trading_day_id = p_trading_day_id
      and ar.quantity_pallets > 0
      and do2.status <> 'open'
    group by ar.customer_company_id
  ) totals
  join public.profiles p on p.company_id = totals.customer_company_id
  cross join public.alert_types at
  where at.id = v_customer_alert_type_id;
  get diagnostics v_customer_count = row_count;

  insert into public.alerts (
    intended_for_user_id, alert_type_id, display_record_id,
    number_for_display, send_as_whatsapp, send_as_notification
  )
  select
    p.user_id, v_grower_alert_type_id, p_trading_day_id,
    totals.pallets, at.send_as_whatsapp_default, at.send_as_notification_default
  from (
    select dp.grower_company_id, sum(ar.quantity_pallets) as pallets
    from public.arrangement_records ar
    join public.daily_pick_products dpp on dpp.id = ar.daily_pick_product_id
    join public.daily_picks dp on dp.id = dpp.daily_pick_id
    where dp.trading_day_id = p_trading_day_id
      and ar.quantity_pallets > 0
    group by dp.grower_company_id
  ) totals
  join public.profiles p on p.company_id = totals.grower_company_id
  cross join public.alert_types at
  where at.id = v_grower_alert_type_id;
  get diagnostics v_grower_count = row_count;

  return v_customer_count + v_grower_count;
end;
$$;

create or replace function public.create_alert(
  p_intended_for_user_id uuid,
  p_alert_type_id uuid,
  p_display_record_id uuid default null,
  p_number_for_display numeric default null,
  p_full_name_for_display text default null,
  p_send_as_whatsapp boolean default null,
  p_send_as_notification boolean default null
)
returns public.alerts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alert_type public.alert_types;
  v_alert public.alerts;
begin
  -- SECURITY (0076): ALLOWS only a signed-in backoffice account.
  -- PROTECTS AGAINST every other caller — including a signed-in account with
  -- no profile and a caller who is not signed in at all. Both have a NULL
  -- role, and the old `<>` comparison is never true for NULL, so it let them
  -- through; `is distinct from` counts NULL as "not backoffice" and refuses.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select * into v_alert_type from public.alert_types where id = p_alert_type_id;
  if not found then
    raise exception 'NOT_FOUND: alert type % does not exist', p_alert_type_id using errcode = 'P0002';
  end if;

  if not exists (select 1 from public.profiles where user_id = p_intended_for_user_id) then
    raise exception 'NOT_FOUND: user % does not exist', p_intended_for_user_id using errcode = 'P0002';
  end if;

  insert into public.alerts (
    intended_for_user_id, alert_type_id, display_record_id,
    number_for_display, full_name_for_display, send_as_whatsapp, send_as_notification
  )
  values (
    p_intended_for_user_id, p_alert_type_id, p_display_record_id,
    p_number_for_display, p_full_name_for_display,
    coalesce(p_send_as_whatsapp, v_alert_type.send_as_whatsapp_default),
    coalesce(p_send_as_notification, v_alert_type.send_as_notification_default)
  )
  returning * into v_alert;

  return v_alert;
end;
$$;

create or replace function public.revert_pick_to_draft(p_daily_pick_id uuid)
returns public.daily_picks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pick public.daily_picks;
begin
  -- SECURITY (0076): ALLOWS only a signed-in backoffice account.
  -- PROTECTS AGAINST every other caller — including a signed-in account with
  -- no profile and a caller who is not signed in at all. Both have a NULL
  -- role, and the old `<>` comparison is never true for NULL, so it let them
  -- through; `is distinct from` counts NULL as "not backoffice" and refuses.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select * into v_pick from public.daily_picks where id = p_daily_pick_id for update;
  if not found then
    raise exception 'NOT_FOUND: pick % does not exist', p_daily_pick_id using errcode = 'P0002';
  end if;

  -- A pick can only be 'submitted' while the trading day is still open —
  -- close_arrangement mass-closes every pick for the day to 'closed', so by
  -- the time the day is closed nothing is left in 'submitted' to revert.
  -- This check is therefore sufficient on its own; no separate day-phase
  -- check is needed.
  if v_pick.status <> 'submitted' then
    raise exception 'INVALID_STATE: pick % is % — can only revert to draft from submitted', p_daily_pick_id, v_pick.status
      using errcode = 'P0007';
  end if;

  update public.daily_picks
  set status = 'draft', submitted_at = null, pickup_time = null, updated_at = now()
  where id = p_daily_pick_id
  returning * into v_pick;

  return v_pick;
end;
$$;

create or replace function public.save_pick_lines(
  p_daily_pick_id uuid,
  p_lines jsonb
)
returns setof public.daily_pick_products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grower_company_id uuid;
  v_grower_company_name text;
  v_pick_status public.daily_pick_status;
  v_trading_day_id uuid;
  v_trade_date date;
  v_is_grower_initiated boolean;
  v_line jsonb;
  v_line_id uuid;
  v_pallets numeric;
  v_leftover numeric;
  v_comment text;
  v_existing public.daily_pick_products;
  v_arranged numeric;
  v_any_quantity_changed boolean := false;
begin
  v_is_grower_initiated := public.current_role() = 'grower';

  select dp.grower_company_id, dp.status, dp.trading_day_id, gc.name
    into v_grower_company_id, v_pick_status, v_trading_day_id, v_grower_company_name
  from public.daily_picks dp
  join public.companies gc on gc.id = dp.grower_company_id
  where dp.id = p_daily_pick_id
  for update of dp;

  if not found then
    raise exception 'NOT_FOUND: daily pick % does not exist', p_daily_pick_id using errcode = 'P0002';
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
          or v_grower_company_id is distinct from public.current_company_id()) then
    raise exception 'FORBIDDEN: not this pick''s grower' using errcode = '42501';
  end if;

  if v_pick_status = 'closed' then
    raise exception 'INVALID_STATE: this pick is closed — no further edits are permitted' using errcode = 'P0007';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_id := (v_line ->> 'dailyPickProductId')::uuid;
    v_pallets := (v_line ->> 'palletsPicked')::numeric;
    v_leftover := (v_line ->> 'leftoverPallets')::numeric;
    v_comment := nullif(v_line ->> 'comment', '');

    if v_pallets is null then
      raise exception 'INVALID_INPUT: pallets picked is required for line %', v_line_id using errcode = 'P0008';
    end if;

    if v_pallets < 0 then
      raise exception 'INVALID_INPUT: pallets picked cannot be negative' using errcode = 'P0008';
    end if;

    if v_leftover is null then
      raise exception 'INVALID_INPUT: leftover pallets is required for line %', v_line_id using errcode = 'P0008';
    end if;

    if v_leftover < 0 then
      raise exception 'INVALID_INPUT: leftover pallets cannot be negative' using errcode = 'P0008';
    end if;

    select * into v_existing
    from public.daily_pick_products
    where id = v_line_id
    for update;

    if not found then
      raise exception 'NOT_FOUND: pick product line % does not exist', v_line_id using errcode = 'P0002';
    end if;

    if v_existing.daily_pick_id <> p_daily_pick_id then
      raise exception 'FORBIDDEN: pick product line % does not belong to daily pick %',
        v_line_id, p_daily_pick_id using errcode = '42501';
    end if;

    -- The arrangement-edit floor, extended to the COMBINED total: a grower
    -- may not retract supply the distributor has already committed to
    -- customers, but may freely shift quantity between picked and leftover
    -- (or zero out leftover that's gone bad) as long as the sum holds.
    -- Evaluated only when either field actually changed, so re-saving an
    -- untouched line can never fail on a floor breached by someone else's
    -- later allocation.
    if v_pallets <> v_existing.pallets_picked or v_leftover <> coalesce(v_existing.leftover_pallets, 0) then
      select coalesce(sum(quantity_pallets), 0) into v_arranged
      from public.arrangement_records
      where daily_pick_product_id = v_line_id;

      if v_pallets + v_leftover < v_arranged then
        raise exception
          'CONFLICT: cannot reduce pallets picked + leftover to % — % pallets already arranged to customers for this line',
          v_pallets + v_leftover, v_arranged
          using errcode = 'P0006';
      end if;

      v_any_quantity_changed := true;
    end if;

    update public.daily_pick_products
    set pallets_picked = v_pallets,
        leftover_pallets = v_leftover,
        comment = v_comment,
        updated_at = now()
    where id = v_line_id;
  end loop;

  -- ONE pick_updated alert per save, not one per changed line. Still gated on
  -- the grower being the actor: backoffice editing a pick on the grower's
  -- behalf must not notify backoffice about backoffice's own action.
  if v_is_grower_initiated and v_any_quantity_changed then
    select trade_date into v_trade_date from public.trading_days where id = v_trading_day_id;
    perform public.enqueue_backoffice_notification(
      v_trading_day_id, 'pick_updated',
      jsonb_build_object('tradeDate', v_trade_date, 'lines', '[]'::jsonb, 'companyName', v_grower_company_name)
    );
  end if;

  return query
    select * from public.daily_pick_products
    where daily_pick_id = p_daily_pick_id
    order by product_variety_id;
end;
$$;

create or replace function public.update_pick_product_details(
  p_daily_pick_product_id uuid,
  p_comment text
)
returns public.daily_pick_products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line public.daily_pick_products;
  v_grower_company_id uuid;
  v_pick_status public.daily_pick_status;
begin
  select dp.grower_company_id, dp.status
    into v_grower_company_id, v_pick_status
  from public.daily_pick_products dpp
  join public.daily_picks dp on dp.id = dpp.daily_pick_id
  where dpp.id = p_daily_pick_product_id
  for update of dpp;

  if not found then
    raise exception 'NOT_FOUND: pick product line % does not exist', p_daily_pick_product_id using errcode = 'P0002';
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
          or v_grower_company_id is distinct from public.current_company_id()) then
    raise exception 'FORBIDDEN: not this pick''s grower' using errcode = '42501';
  end if;

  if v_pick_status = 'closed' then
    raise exception 'INVALID_STATE: this pick is closed — no further edits are permitted' using errcode = 'P0007';
  end if;

  update public.daily_pick_products
  set comment = p_comment, updated_at = now()
  where id = p_daily_pick_product_id
  returning * into v_line;

  return v_line;
end;
$$;

create or replace function public.update_pick_product_pallets(
  p_daily_pick_product_id uuid,
  p_pallets_picked numeric
)
returns public.daily_pick_products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line public.daily_pick_products;
  v_grower_company_id uuid;
  v_grower_company_name text;
  v_pick_status public.daily_pick_status;
  v_trading_day_id uuid;
  v_trade_date date;
  v_leftover numeric;
  v_arranged numeric;
  v_is_grower_initiated boolean;
begin
  if p_pallets_picked < 0 then
    raise exception 'INVALID_INPUT: pallets picked cannot be negative' using errcode = 'P0008';
  end if;

  v_is_grower_initiated := public.current_role() = 'grower';

  select dp.grower_company_id, dp.status, dp.trading_day_id, gc.name, dpp.leftover_pallets
    into v_grower_company_id, v_pick_status, v_trading_day_id, v_grower_company_name, v_leftover
  from public.daily_pick_products dpp
  join public.daily_picks dp on dp.id = dpp.daily_pick_id
  join public.companies gc on gc.id = dp.grower_company_id
  where dpp.id = p_daily_pick_product_id
  for update of dpp;

  if not found then
    raise exception 'NOT_FOUND: pick product line % does not exist', p_daily_pick_product_id using errcode = 'P0002';
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
          or v_grower_company_id is distinct from public.current_company_id()) then
    raise exception 'FORBIDDEN: not this pick''s grower' using errcode = '42501';
  end if;

  if v_pick_status = 'closed' then
    raise exception 'INVALID_STATE: this pick is closed — no further edits are permitted' using errcode = 'P0007';
  end if;

  select coalesce(sum(quantity_pallets), 0) into v_arranged
  from public.arrangement_records
  where daily_pick_product_id = p_daily_pick_product_id;

  if p_pallets_picked + coalesce(v_leftover, 0) < v_arranged then
    raise exception
      'CONFLICT: cannot reduce pallets picked + leftover to % — % pallets already arranged to customers for this line',
      p_pallets_picked + coalesce(v_leftover, 0), v_arranged
      using errcode = 'P0006';
  end if;

  update public.daily_pick_products
  set pallets_picked = p_pallets_picked, updated_at = now()
  where id = p_daily_pick_product_id
  returning * into v_line;

  if v_is_grower_initiated then
    select trade_date into v_trade_date from public.trading_days where id = v_trading_day_id;
    perform public.enqueue_backoffice_notification(
      v_trading_day_id, 'pick_updated',
      jsonb_build_object('tradeDate', v_trade_date, 'lines', '[]'::jsonb, 'companyName', v_grower_company_name)
    );
  end if;

  return v_line;
end;
$$;

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

  update public.daily_picks
  set status = 'submitted', submitted_at = now(), pickup_time = v_pickup_time, updated_at = now()
  where id = p_daily_pick_id
  returning * into v_pick;

  return v_pick;
end;
$$;

create or replace function public.submit_order(
  p_trading_day_id uuid,
  p_lines jsonb,
  p_customer_company_id uuid default null
)
returns public.daily_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.daily_orders;
  v_phase public.trading_day_phase;
  v_trade_date date;
  v_line jsonb;
  v_kept_ids uuid[] := '{}';
  v_line_id uuid;
  v_pallets numeric;
  v_comment text;
  v_variety_id uuid;
  v_customer_company_id uuid;
  v_customer_company_name text;
  v_direct_customer_submission boolean;
  v_touched_variety_ids uuid[];
  v_demand_before_snapshot jsonb;
  v_demand_before numeric;
  v_demand_after numeric;
  v_supply numeric;
  v_overbooking numeric;
  v_product_name text;
  v_remaining numeric;
  v_max_orderable numeric;
  v_saved_pallets numeric;
  v_blocked_variety_ids uuid[] := '{}';
begin
  v_direct_customer_submission := p_customer_company_id is null and public.current_role() = 'customer';

  -- SECURITY: ALLOWS a customer to send their own company's order, and a
  -- backoffice account to send any customer's order on their behalf ("בשם
  -- לקוח"). PROTECTS AGAINST a customer or grower writing another company's
  -- order, a grower ordering at all, and (0076) a signed-in account with no
  -- profile or a caller who is not signed in at all. Those two have a NULL
  -- role. Until 0076 both checks used `<>`, which is never true for NULL, so
  -- neither raised for them — and a send naming another company
  -- (p_customer_company_id) went straight through and was written. They now
  -- use `is distinct from`, which counts NULL as a mismatch and refuses.
  if p_customer_company_id is not null then
    if public.current_role() is distinct from 'backoffice' then
      raise exception 'FORBIDDEN: only backoffice may submit an order on another company''s behalf' using errcode = '42501';
    end if;
    v_customer_company_id := p_customer_company_id;
  else
    if public.current_role() is distinct from 'customer' then
      raise exception 'FORBIDDEN: customer role required' using errcode = '42501';
    end if;
    v_customer_company_id := public.current_company_id();
  end if;

  -- 0071: `for share` — read the day's phase and keep it from changing until
  -- this send is done. ALLOWS any number of order sends at once (shared locks
  -- don't block each other). PROTECTS AGAINST a send and a phase change
  -- crossing: open_shop, close_shop and close_arrangement all start by
  -- locking this same row `for update`, so a send that arrives while the
  -- shop is closing waits for the close to finish and then sees the new
  -- phase, and a close that arrives during a send waits for the send. They
  -- lock nothing before this row, so the two can never wait on each other in
  -- a circle.
  select phase, trade_date into v_phase, v_trade_date from public.trading_days where id = p_trading_day_id for share;
  if not found then
    raise exception 'NOT_FOUND: trading day % does not exist', p_trading_day_id using errcode = 'P0002';
  end if;
  if v_phase = 'closed' then
    raise exception 'INVALID_STATE: cannot submit an order once the trading day is closed' using errcode = 'P0007';
  end if;

  -- 0071: SHOP HOURS — ALLOWS a customer to send their own order only while
  -- the shop is open (phase shop_open). PROTECTS AGAINST an order changing
  -- after close_shop, while the distributor is already arranging from the
  -- numbers — the order screen checks this before sending, but a send in the
  -- moment of closing, from a screen that missed the close, or straight
  -- through the API, used to be accepted until the whole day closed. Staff
  -- ordering on a customer's behalf ("בשם לקוח") are not limited by this:
  -- they may still adjust orders while arranging, up to the day's close (the
  -- check above).
  if v_direct_customer_submission and v_phase <> 'shop_open' then
    raise exception 'INVALID_STATE: the shop is closed for orders' using errcode = 'P0007';
  end if;

  select * into v_order
  from public.daily_orders
  where trading_day_id = p_trading_day_id
    and customer_company_id = v_customer_company_id
  for update;

  if not found then
    raise exception 'NOT_FOUND: no daily order exists for this company on this trading day' using errcode = 'P0002';
  end if;

  -- 0068: STOCK — one order send at a time for each trading day.
  -- ALLOWS every send to go through exactly as before, only in turn.
  -- PROTECTS AGAINST two customers taking the same last pallets. Each send
  -- checks how much is still free (max_orderable_for_customer, below) against
  -- what OTHER customers have already ordered; without this, two sends running
  -- at the same moment each read the stock before the other had saved, both
  -- passed, and together ordered more than exists (reproduced on Postgres 17:
  -- 7 + 7 accepted against 10). Now the second send waits — milliseconds —
  -- for the first to finish, then sees its order. Taken only here, once the
  -- caller is known to have an order for this day, so a call that is refused
  -- above (anonymous, no profile, wrong role, no order) never holds anyone up.
  -- A transaction-level advisory lock: released by itself when this send
  -- commits or fails, and taken nowhere else in the database. Every send locks
  -- its own order row (just above) before this, and touches no other order,
  -- so two sends can never wait on each other in a circle. Backoffice sends
  -- take it too: their pallets count against what customers may still order.
  perform pg_advisory_xact_lock(hashtextextended('submit_order:' || p_trading_day_id::text, 0));

  -- 0072: BLOCKED PRODUCTS. SECURITY: on a customer's own send, ALLOWS
  -- changes only to lines for products that are not on their own blocked
  -- list; a line for a blocked product is left exactly as it is — not
  -- added, not changed, not removed. It PROTECTS AGAINST a customer ordering
  -- a product blocked for them by calling this directly (their order screen
  -- no longer shows one — get_orderable_catalog_for_customer, above), and
  -- against their save deleting a colleague's or the distributor's line for
  -- that product: they are never shown it, so it is never in what they send,
  -- and the prune below would otherwise take every line it is not sent.
  -- Ignored rather than refused, so a screen opened before the block was set
  -- can still save everything else. Staff sending on a customer's behalf are
  -- not affected (Bubble's list, too, applied only to the customer's own
  -- shop).
  if v_direct_customer_submission then
    select coalesce(array_agg(b.product_variety_id), '{}')
    into v_blocked_variety_ids
    from public.profile_blocked_products b
    where b.user_id = (select auth.uid());
  end if;

  -- Snapshot demand-before for every variety this call could possibly
  -- push across a threshold, BEFORE the upsert loop touches anything.
  select array_agg(distinct (line ->> 'productVarietyId')::uuid)
  into v_touched_variety_ids
  from jsonb_array_elements(p_lines) as line
  where (line ->> 'palletsOrdered')::numeric > 0;

  select jsonb_object_agg(v.variety_id::text, coalesce(d.total, 0))
  into v_demand_before_snapshot
  from unnest(coalesce(v_touched_variety_ids, '{}'::uuid[])) as v(variety_id)
  left join lateral (
    select sum(dop.pallets_ordered) as total
    from public.daily_order_products dop
    join public.daily_orders do2 on do2.id = dop.daily_order_id
    where do2.trading_day_id = p_trading_day_id
      and dop.product_variety_id = v.variety_id
  ) d on true;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_pallets := (v_line ->> 'palletsOrdered')::numeric;
    v_comment := nullif(v_line ->> 'comment', '');
    v_variety_id := (v_line ->> 'productVarietyId')::uuid;

    if v_pallets < 0 then
      raise exception 'INVALID_INPUT: pallets ordered cannot be negative' using errcode = 'P0008';
    end if;

    if v_pallets = 0 then
      continue;
    end if;

    -- 0072: a product blocked for this customer — see BLOCKED PRODUCTS above.
    if v_variety_id = any (v_blocked_variety_ids) then
      continue;
    end if;

    if not exists (
      select 1 from public.daily_pick_products dpp
      join public.daily_picks dp on dp.id = dpp.daily_pick_id
      where dp.trading_day_id = p_trading_day_id
        and dpp.product_variety_id = v_variety_id
    ) then
      raise exception 'INVALID_INPUT: product variety % is not in today''s shop', v_variety_id using errcode = 'P0008';
    end if;

    -- The dropdown's own ceiling, re-checked server-side so a direct API
    -- call can't exceed what the UI offered — never applied to the
    -- backoffice on-behalf-of path, where staff may deliberately override
    -- it (see max_orderable_for_customer's comment).
    --
    -- 0068: and only to a line that goes UP. A quantity the customer already
    -- has saved stays theirs when stock later drops below it: re-sending the
    -- order with that line untouched, or lowering it, is accepted, and only
    -- an increase is held to the limit. The order screen's dropdown already
    -- keeps the saved number on offer for exactly this case (see
    -- dropdownOptions in apps/web/src/components/customer/order-product-list.tsx),
    -- as Bubble's did; until now the server then refused the whole send
    -- because of it, losing every other change the customer had made.
    if v_direct_customer_submission then
      select pallets_ordered into v_saved_pallets
      from public.daily_order_products
      where daily_order_id = v_order.id and product_variety_id = v_variety_id;

      if v_pallets > coalesce(v_saved_pallets, 0) then
        v_max_orderable := public.max_orderable_for_customer(p_trading_day_id, v_variety_id, v_customer_company_id);
        if v_pallets > v_max_orderable then
          raise exception 'INVALID_INPUT: % pallets requested exceeds the % pallet limit available for this product', v_pallets, v_max_orderable
            using errcode = 'P0008';
        end if;
      end if;
    end if;

    insert into public.daily_order_products (daily_order_id, product_variety_id, pallets_ordered, comment)
    values (v_order.id, v_variety_id, v_pallets, v_comment)
    on conflict (daily_order_id, product_variety_id)
    do update set pallets_ordered = excluded.pallets_ordered, comment = excluded.comment, updated_at = now()
    returning id into v_line_id;

    v_kept_ids := v_kept_ids || v_line_id;
  end loop;

  -- Prune, but never destroy an allocation.
  --
  -- This used to be a bare DELETE of every line not present in p_lines,
  -- and arrangement_records.daily_order_product_id is ON DELETE CASCADE —
  -- so re-saving an order silently deleted the distributor's arrangement
  -- records for any line it dropped. That was already true for ordinary
  -- lines; it becomes a certainty with the zero-quantity lines
  -- arrange_to_customer creates, because submit_order skips zero-pallet
  -- lines entirely (see the `continue` above) and therefore never keeps
  -- one.
  --
  -- A line that something is arranged against is zeroed instead: the
  -- customer's request really is gone, which is what pallets_ordered = 0
  -- now means, but the pallets already committed to them stay visible on
  -- the arrangement board for the distributor to settle deliberately.
  --
  -- 0072: neither touches a line for a product blocked for this customer
  -- (v_blocked_variety_ids is empty for every other caller) — see BLOCKED
  -- PRODUCTS above.
  update public.daily_order_products
  set pallets_ordered = 0, comment = null, updated_at = now()
  where daily_order_id = v_order.id
    and not (id = any (v_kept_ids))
    and not (product_variety_id = any (v_blocked_variety_ids))
    and exists (
      select 1 from public.arrangement_records ar
      where ar.daily_order_product_id = daily_order_products.id
    );

  delete from public.daily_order_products
  where daily_order_id = v_order.id
    and not (id = any (v_kept_ids))
    and not (product_variety_id = any (v_blocked_variety_ids))
    and not exists (
      select 1 from public.arrangement_records ar
      where ar.daily_order_product_id = daily_order_products.id
    );

  update public.daily_orders
  set status = 'submitted', submitted_at = now(), updated_at = now()
  where id = v_order.id
  returning * into v_order;

  insert into public.order_submission_logs (daily_order_id, submitted_by, snapshot)
  values (v_order.id, (select auth.uid()), p_lines);

  -- id 6.
  if v_direct_customer_submission then
    select name into v_customer_company_name from public.companies where id = v_customer_company_id;
    perform public.enqueue_backoffice_notification(
      p_trading_day_id, 'order_submitted',
      jsonb_build_object('tradeDate', v_trade_date, 'lines', '[]'::jsonb, 'companyName', v_customer_company_name)
    );
  end if;

  -- ids 10/11.
  if v_touched_variety_ids is not null then
    foreach v_variety_id in array v_touched_variety_ids
    loop
      v_demand_before := coalesce((v_demand_before_snapshot ->> v_variety_id::text)::numeric, 0);

      select coalesce(sum(dop.pallets_ordered), 0) into v_demand_after
      from public.daily_order_products dop
      join public.daily_orders do2 on do2.id = dop.daily_order_id
      where do2.trading_day_id = p_trading_day_id
        and dop.product_variety_id = v_variety_id;

      select coalesce(sum(dpp.pallets_picked), 0) + coalesce(sum(dpp.leftover_pallets), 0) into v_supply
      from public.daily_pick_products dpp
      join public.daily_picks dp on dp.id = dpp.daily_pick_id
      where dp.trading_day_id = p_trading_day_id
        and dpp.product_variety_id = v_variety_id;

      select coalesce(no_overbooking, 0), name into v_overbooking, v_product_name
      from public.product_varieties where id = v_variety_id;

      if v_demand_before < v_supply and v_demand_after >= v_supply and v_demand_after < (v_supply + v_overbooking) then
        v_remaining := (v_supply + v_overbooking) - v_demand_after;
        perform public.enqueue_backoffice_notification(
          p_trading_day_id, 'stock_overbooking_reached',
          jsonb_build_object(
            'tradeDate', v_trade_date, 'lines', '[]'::jsonb,
            'productName', v_product_name,
            'productOverbooking', regexp_replace(v_remaining::text, '\.?0+$', '')
          )
        );
      elsif v_demand_before < (v_supply + v_overbooking) and v_demand_after >= (v_supply + v_overbooking) then
        perform public.enqueue_backoffice_notification(
          p_trading_day_id, 'stock_fully_exhausted',
          jsonb_build_object('tradeDate', v_trade_date, 'lines', '[]'::jsonb, 'productName', v_product_name)
        );
      end if;
    end loop;
  end if;

  return v_order;
end;
$$;

-- SECURITY: ALLOWS signed-in users (`authenticated`) and the service role to
-- call these eight — each function then decides, with the checks above, which
-- signed-in user may go on. PROTECTS AGAINST callers who are not signed in
-- reaching them at all: Postgres grants EXECUTE on every new function to
-- PUBLIC, and Supabase's default privileges add `anon`, so both are revoked
-- here (the same reasoning as 0055 on enqueue_backoffice_notification, and
-- 0059 / 0062 on discard_business_day / set_pick_closed). No screen calls any
-- of them before signing in.
revoke execute on function public.build_arrangement_alerts(uuid) from public, anon;
grant execute on function public.build_arrangement_alerts(uuid) to authenticated, service_role;
revoke execute on function public.create_alert(uuid, uuid, uuid, numeric, text, boolean, boolean) from public, anon;
grant execute on function public.create_alert(uuid, uuid, uuid, numeric, text, boolean, boolean) to authenticated, service_role;
revoke execute on function public.revert_pick_to_draft(uuid) from public, anon;
grant execute on function public.revert_pick_to_draft(uuid) to authenticated, service_role;
revoke execute on function public.save_pick_lines(uuid, jsonb) from public, anon;
grant execute on function public.save_pick_lines(uuid, jsonb) to authenticated, service_role;
revoke execute on function public.update_pick_product_details(uuid, text) from public, anon;
grant execute on function public.update_pick_product_details(uuid, text) to authenticated, service_role;
revoke execute on function public.update_pick_product_pallets(uuid, numeric) from public, anon;
grant execute on function public.update_pick_product_pallets(uuid, numeric) to authenticated, service_role;
revoke execute on function public.submit_pick(uuid) from public, anon;
grant execute on function public.submit_pick(uuid) to authenticated, service_role;
revoke execute on function public.submit_order(uuid, jsonb, uuid) from public, anon;
grant execute on function public.submit_order(uuid, jsonb, uuid) to authenticated, service_role;

-- SECURITY: ALLOWS only the functions that need these two helpers —
-- get_orderable_catalog_for_customer and submit_order, both SECURITY DEFINER
-- and owned by postgres, so they run as postgres, which keeps its own grant —
-- and the service role. PROTECTS AGAINST anyone calling them straight through
-- the API: neither has a caller check, so until now any caller, signed in or
-- not, could read any customer's order limit for any product and the shop's
-- stock state for any day. The app reads the same numbers only through the
-- catalog, which checks who is asking.
revoke execute on function public.max_orderable_for_customer(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.max_orderable_for_customer(uuid, uuid, uuid) to service_role;
revoke execute on function public.shop_variety_orderability(uuid) from public, anon, authenticated;
grant execute on function public.shop_variety_orderability(uuid) to service_role;
