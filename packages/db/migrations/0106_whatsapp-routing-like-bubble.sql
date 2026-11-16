-- 0106 — each WhatsApp message follows Bubble's routing rule.
--
-- Until now every message used one rule: the company's WhatsApp group if it has
-- one, otherwise each person with a usable phone. The old Bubble app chose per
-- message type. This migration makes Ori do the same. Section 1 (this part):
--   outbox_routing(template_key) names a message type's rule, and
--   resolve_outbox_dispatch follows it:
--     pick_reminder -> the group AND each person privately
--     shop_open     -> each person privately, never the group
--     pick_updated  -> the grower's own group only
--     anything else -> the group, else each person (as before)
--   A row that lists its recipients (recipient_user_ids, 0104) is unchanged:
--   it goes privately to exactly those people, whatever the rule says.
--
-- Rollout (design 2026-11-16, section 9): 0106 and the web deploy can go in
-- either order; the recommended order is to run 0106, then push the website.
-- The whatsapp-dispatch edge function is NOT redeployed: resolve_outbox_dispatch
-- keeps its signature, result columns, security and grants. Rows queued before
-- 0106 and sent after it follow the new rules when they are sent.
--
-- Safe to run again: every statement is create or replace / revoke / grant.

-- 1. outbox_routing: one place that says, per message type, who it reaches.
-- Pure lookup on the template key; it reads no table, so it is immutable.
--
-- SECURITY: the function itself only maps a text key to a word and exposes no
-- data. The revoke/grant below ALLOW signed-in sessions and the service role to
-- call it, and PROTECT AGAINST a visitor who is not signed in (and PUBLIC)
-- reaching it at all — they stop at "permission denied".
create or replace function public.outbox_routing(p_template_key text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_template_key
    -- Bubble's pick reminder (the bell on "in the grower's name") posts in the
    -- grower's group and also messages each person privately.
    when 'pick_reminder' then 'group_and_people'
    -- Bubble tells the shop's customers one by one when the shop opens; it
    -- never posts to the customer company's group.
    when 'shop_open' then 'people_only'
    -- Bubble posts "the grower updated the pick estimate" in that grower's own
    -- group only; the office is not messaged person by person.
    when 'pick_updated' then 'group_only'
    -- Everything else keeps Bubble's usual way: the group, else each person.
    else 'group_else_people'
  end;
$$;

comment on function public.outbox_routing(text) is
  'Names the routing rule of one message type (migration 0106), as Bubble does it: pick_reminder = group_and_people (the group and each person), shop_open = people_only (each person, never the group), pick_updated = group_only (the grower''s group only), anything else = group_else_people (the group, else each person). Used by resolve_outbox_dispatch.';

-- SECURITY: ALLOWS signed-in sessions and the service role to call it.
-- PROTECTS AGAINST a visitor who is not signed in (and PUBLIC) reaching it.
revoke execute on function public.outbox_routing(text) from public, anon;
grant execute on function public.outbox_routing(text) to authenticated, service_role;

-- 2. resolve_outbox_dispatch: same signature, result columns and security as
-- 0102/0104. The only change is which of the group and the people a row
-- reaches, now by outbox_routing(template_key). A row that carries a list of
-- users (0104) skips the group and goes to those users only.
--
-- SECURITY: unchanged from 0081/0102/0104 — security invoker, so the caller's
-- own row-level security applies. ALLOWS the dispatcher (service-role key) and
-- a backoffice session to resolve any row. PROTECTS AGAINST any other signed-in
-- user reading a composed message or other companies' phone numbers: their
-- read of notification_outbox finds no row, and the call stops at NOT_FOUND.
create or replace function public.resolve_outbox_dispatch(p_outbox_id uuid)
returns table(target text, is_group boolean, message text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.notification_outbox;
  v_company public.companies;
  v_rule text;
  v_has_group boolean;
begin
  select * into v_row from public.notification_outbox where id = p_outbox_id;
  if not found then
    raise exception 'NOT_FOUND: notification_outbox row % does not exist', p_outbox_id using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.notification_templates where template_key = v_row.template_key) then
    raise exception 'NOT_FOUND: notification template % does not exist', v_row.template_key using errcode = 'P0002';
  end if;

  select * into v_company from public.companies where id = v_row.recipient_company_id;

  v_rule := public.outbox_routing(v_row.template_key);
  v_has_group := v_company.whatsapp_group_id is not null and v_company.whatsapp_group_id <> '';

  -- A WhatsApp group: one message, addressed to the company by name. Never for
  -- a row that lists its people (0104), and only for a rule that includes it.
  if v_row.recipient_user_ids is null and v_has_group
     and v_rule in ('group_and_people', 'group_only', 'group_else_people') then
    return query select v_company.whatsapp_group_id, true, public.compose_outbox_message(v_row, v_company.name);
  end if;

  -- Each user with a number Ori can message, by their first name. A row that
  -- lists its users (0104) always goes to them, whatever the rule. Otherwise
  -- the rule decides: always for people_only and group_and_people, only when
  -- there is no group for group_else_people, never for group_only.
  if v_row.recipient_user_ids is not null
     or v_rule in ('people_only', 'group_and_people')
     or (v_rule = 'group_else_people' and not v_has_group) then
    return query
    select
      public.whatsapp_personal_number(p.phone_number),
      false,
      public.compose_outbox_message(v_row, split_part(p.display_name, ' ', 1))
    from public.profiles p
    where p.company_id = v_row.recipient_company_id
      and (v_row.recipient_user_ids is null or p.user_id = any(v_row.recipient_user_ids))
      and public.whatsapp_personal_number(p.phone_number) is not null
    order by p.user_id;
  end if;
end;
$$;

comment on function public.resolve_outbox_dispatch(uuid) is
  'Resolves one notification_outbox row into its actual send targets, following the message type''s rule (outbox_routing, migration 0106): the recipient company''s WhatsApp group (one row, the bare group id, is_group = true) and/or each user with a phone number on file (is_group = false, addressed by country code and number — whatsapp_personal_number, 0077), in user order. pick_reminder = the group and each person; shop_open = each person only; pick_updated = the group only; anything else = the group, else each person. A row that carries recipient_user_ids (0104) never uses the group: it goes privately to exactly those users of the recipient company who have a number. A user whose number cannot be read as a phone number is skipped. The text is compose_outbox_message''s (Bubble''s wording and layouts, migration 0102): %FIRST_NAME% is the company''s name for a group, else the user''s first name. Raises P0002 if the outbox row or its template_key does not resolve.';

-- 3. enqueue_company_notification: queue one message for ONE named company
-- (the office helper, enqueue_backoffice_notification, only reaches the
-- office). Same 5-per-10-minutes cap as 0082, counted per company, message
-- type and day, so saving over and over cannot flood that company's group.
-- p_recipient_user_ids (0104) is optional: when given, the row goes privately
-- to exactly those people instead of the group.
--
-- SECURITY: ALLOWS ordinary use — up to 5 messages of one kind to one company
-- per trading day per 10 minutes, far more than saving and fixing produces.
-- PROTECTS AGAINST a grower or customer flooding a company's WhatsApp group by
-- saving in a loop: past the cap the save still works, it just queues no
-- further message until the window moves on. security definer because the
-- outbox has no insert policy for ordinary users; the revoke below keeps it
-- out of reach of public, anon and signed-in users. It is called by the
-- definer functions that queue messages, and the server's own service-role
-- key can call it too.
create or replace function public.enqueue_company_notification(
  p_trading_day_id uuid,
  p_recipient_type public.notification_recipient_type,
  p_company_id uuid,
  p_template_key text,
  p_payload jsonb,
  p_recipient_user_ids uuid[] default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notification_outbox (
    trading_day_id, recipient_type, recipient_company_id, template_key, payload, recipient_user_ids
  )
  select p_trading_day_id, p_recipient_type, p_company_id, p_template_key, p_payload, p_recipient_user_ids
  where (
    select count(*)
    from public.notification_outbox o
    where o.recipient_company_id = p_company_id
      and o.template_key = p_template_key
      and o.created_at > now() - interval '10 minutes'
      and o.trading_day_id is not distinct from p_trading_day_id
  ) < 5;
end;
$$;

comment on function public.enqueue_company_notification(uuid, public.notification_recipient_type, uuid, text, jsonb, uuid[]) is
  'Internal (migration 0106). Queues one notification_outbox row for one named company, unless 5 rows of the same message type for that company and trading day were already queued in the last 10 minutes. p_recipient_user_ids, when given, lists the people it goes to privately (0104). Called by the security definer functions that queue messages and by the service role; not callable by public, anon or signed-in users.';

-- SECURITY: the same lock-down as enqueue_backoffice_notification (0055). This
-- revoke ALLOWS the security definer functions that call it (they run as
-- postgres, whose own grant this does not touch) and leaves the server's
-- service-role key able to call it (Supabase's default privileges; as for
-- enqueue_backoffice_notification). It PROTECTS AGAINST a
-- customer, a grower or a self-registered account calling it directly through
-- the API to queue WhatsApp messages of their own wording to any company, as
-- many times as they like, which whatsapp-dispatch would then send from the
-- business's own number.
revoke execute on function public.enqueue_company_notification(uuid, public.notification_recipient_type, uuid, text, jsonb, uuid[])
  from public, anon, authenticated;

-- 4. save_pick_lines: 0076's body, changed only where the pick_updated alert is
-- queued — now for the grower's own company instead of the office. Signature,
-- security definer, search_path, SECURITY checks and grants are unchanged.
--
-- SECURITY: security definer ALLOWS the function to write the pick lines and
-- queue the message as the owner, which a grower's own row access cannot do.
-- It PROTECTS AGAINST misuse through the fail-closed role and ownership check
-- at the top of the body (from 0076): only backoffice or this pick's own
-- grower gets past it; everyone else, signed-out callers included, is refused.
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
  -- behalf must not message the grower about backoffice's own action.
  -- 0106: the alert goes to the grower's own company (its WhatsApp group), as
  -- in Bubble, not to the office.
  if v_is_grower_initiated and v_any_quantity_changed then
    select trade_date into v_trade_date from public.trading_days where id = v_trading_day_id;
    perform public.enqueue_company_notification(
      v_trading_day_id, 'grower', v_grower_company_id, 'pick_updated',
      jsonb_build_object('tradeDate', v_trade_date, 'lines', '[]'::jsonb, 'companyName', v_grower_company_name)
    );
  end if;

  return query
    select * from public.daily_pick_products
    where daily_pick_id = p_daily_pick_id
    order by product_variety_id;
end;
$$;

comment on function public.save_pick_lines(uuid, jsonb) is
  'The owning grower (or backoffice). Saves every line of one Daily Pick in a single transaction: pallets_picked, leftover_pallets and comment per line, all-or-nothing. Enforces P0002 unknown pick/line, 42501 wrong grower or a line not belonging to this pick, P0007 closed pick, P0008 negative/missing quantity, and P0006 — the arrangement floor, checked against pallets_picked + leftover_pallets COMBINED, so a grower may shift quantity between the two fields freely as long as the sum never drops below what''s already arranged. Queues at most one pick_updated notification per save, for the grower''s own company (migration 0106), when the grower themselves changed a quantity. Returns the pick''s full line set as saved.';

-- 5. update_pick_product_pallets: 0076's body, changed only where the
-- pick_updated alert is queued (the grower's own company, not the office).
--
-- SECURITY: security definer ALLOWS the function to write the pick line and
-- queue the message as the owner, which a grower's own row access cannot do.
-- It PROTECTS AGAINST misuse through the fail-closed role and ownership check
-- at the top of the body (from 0076): only backoffice or this pick's own
-- grower gets past it; everyone else, signed-out callers included, is refused.
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
    perform public.enqueue_company_notification(
      v_trading_day_id, 'grower', v_grower_company_id, 'pick_updated',
      jsonb_build_object('tradeDate', v_trade_date, 'lines', '[]'::jsonb, 'companyName', v_grower_company_name)
    );
  end if;

  return v_line;
end;
$$;

comment on function public.update_pick_product_pallets(uuid, numeric) is
  'The owning grower (or backoffice). Updates a Daily Pick Product line''s pallets_picked. security definer for the same reason as submit_pick. Enforces the arrangement-edit rule against the COMBINED pallets_picked + leftover_pallets (raises P0006), and rejects edits once the parent pick is closed (P0007). When the caller is the grower themselves (not backoffice acting on their behalf), queues one pick_updated notification_outbox row for the grower''s own company (id 3; migration 0106).';

-- 6. The pick_updated message now reaches the grower, so its link opens the
-- grower's own picks screen, not the office's grower page.
update public.notification_templates
set link = 'https://ori-claude-web.vercel.app/grower/picks', updated_at = now()
where template_key = 'pick_updated';
