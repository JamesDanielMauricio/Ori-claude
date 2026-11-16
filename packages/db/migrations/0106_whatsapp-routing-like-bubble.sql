-- 0106 — each WhatsApp message follows Bubble's routing rule.
--
-- Until now every message used one rule: the company's WhatsApp group if it has
-- one, otherwise each person with a usable phone. The old Bubble app chose per
-- message type. This migration makes Ori do the same, in three parts.
--
-- Part 1, the rules (sections 1 and 2 below):
--   outbox_routing(template_key) names a message type's rule, and
--   resolve_outbox_dispatch follows it:
--     pick_reminder -> the group AND each person privately
--     shop_open     -> each person privately, never the group
--     pick_updated  -> the grower's own group only
--     anything else -> the group, else each person (as before)
--   A row that lists its recipients (recipient_user_ids, 0104) is unchanged:
--   it goes privately to exactly those people, whatever the rule says.
--
-- Part 2, pick_updated goes to the grower's own group (sections 3 to 6):
--   enqueue_company_notification queues a message for one named company, with
--   the same cap as the office's helper (5 per 10 minutes, per company, type
--   and day). save_pick_lines and update_pick_product_pallets use it, so the
--   grower's pick update reaches the grower's group instead of the office, and
--   the pick_updated template's link opens the grower's own picks screen.
--
-- Part 3, a private copy of a new order for the customer who sent it (sections
-- 7 to 9): a new template order_submitted_copy (same text as order_submitted,
-- linking to the customer's order screen), compose_outbox_message listing the
-- order for it too, and submit_order queuing it, to the sending user only,
-- right after the office's message. When the office orders on a customer's
-- behalf nobody gets a copy.
--
-- Rollout (design 2026-11-16, section 9): 0106 and the web deploy can go in
-- either order; the recommended order is to run 0106, then push the website.
-- The whatsapp-dispatch edge function is NOT redeployed: resolve_outbox_dispatch
-- keeps its signature, result columns, security and grants. Rows queued before
-- 0106 and sent after it follow the new rules when they are sent.
--
-- Safe to run again: the functions are create or replace, the revokes and
-- grants repeat harmlessly, the pick_updated link update (section 6) sets the
-- same value, and the new template row (section 7) is insert ... on conflict
-- do nothing, so a second run adds nothing.

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

-- 7. The customer's private copy of a new order (design 2026-11-16, row 6). In
-- Bubble the customer user who sends an order gets the same text as the office,
-- privately. Its own message type, so the office's message log can name it. The
-- text is copied from the order_submitted row as it is now (Bubble's main
-- alert 6); only the title and the link differ: the link opens the customer's
-- own order screen. Run again, it leaves an existing row alone.
--
-- SECURITY: no grant here. notification_templates keeps its own row-level
-- security (0023, forced); this insert runs as the migration's owner.
insert into public.notification_templates (template_key, channel, title, content, link)
select 'order_submitted_copy', t.channel, 'העתק ללקוח ששלח הזמנה', t.content,
       'https://ori-claude-web.vercel.app/customer/order'
from public.notification_templates t
where t.template_key = 'order_submitted'
on conflict (template_key) do nothing;

-- 8. compose_outbox_message: 0102's body, changed only where the order's
-- lines are listed (the details case): the customer's copy lists the order
-- like the office message does.
--
-- SECURITY: unchanged from 0102 — security invoker, so the caller's own
-- row-level security applies. ALLOWS signed-in sessions and the service role to
-- compose a message; PROTECTS AGAINST a visitor who is not signed in (the
-- revoke below) and, through invoker rights, against reading a template or
-- order the caller's own access does not already show.
create or replace function public.compose_outbox_message(p_row public.notification_outbox, p_first_name text)
returns text
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_template public.notification_templates;
  v_recipient public.companies;
  v_content text;
  v_details text;
begin
  select * into v_template from public.notification_templates where template_key = p_row.template_key;
  if not found then
    raise exception 'NOT_FOUND: notification template % does not exist', p_row.template_key using errcode = 'P0002';
  end if;
  select * into v_recipient from public.companies where id = p_row.recipient_company_id;

  v_content := v_template.content;
  -- Glitch 2, fixed (James, 2026-11-13): Bubble ends every grower's message
  -- "הודעה זו נשלחה גם למוביל" (this was also sent to the transporter); here
  -- only when the grower has a transporter. (A template edited away from
  -- Bubble's text is left as it is.)
  if p_row.template_key = 'close_arrangement_grower' and v_recipient.transporter_company_id is null then
    v_content := replace(v_content, ' %NL%' || chr(10) || 'הודעה זו נשלחה גם למוביל', '');
  end if;

  v_details := case
    when p_row.template_key in ('order_submitted', 'order_submitted_copy') and p_row.payload ? 'dailyOrderId'
      then public.compose_order_submitted_details((p_row.payload ->> 'dailyOrderId')::uuid)
    else public.compose_order_details_text(p_row.payload)
  end;

  -- In the order Bubble's workflows fill them. %COMPANY% falls back to the
  -- recipient's own name: the grower's message names the grower itself.
  v_content := replace(v_content, '%FIRST_NAME%', coalesce(p_first_name, ''));
  v_content := replace(v_content, '%COMPANY_USER_FULL_NAME%', coalesce(p_row.payload ->> 'submittedByName', ''));
  v_content := replace(v_content, '%COMPANY%', coalesce(p_row.payload ->> 'companyName', v_recipient.name, ''));
  v_content := replace(v_content, '%ORDER_DETAILS%', coalesce(v_details, ''));
  v_content := replace(v_content, '%NL%', chr(10));
  v_content := replace(
    v_content, '%CURRENT_OPEN_BUSINESS_DAY%',
    public.message_trade_date(
      nullif(p_row.payload ->> 'tradeDate', '')::date,
      p_row.template_key not in ('close_arrangement_grower', 'close_arrangement_grower_transporter')
    )
  );
  v_content := replace(v_content, '%PICKUP_TIME%', coalesce(p_row.payload ->> 'pickupTime', ''));
  v_content := replace(v_content, '%PRODUCT_NAME%', coalesce(p_row.payload ->> 'productName', ''));
  v_content := replace(v_content, '%PRODUCT_OVERBOOKING%', coalesce(p_row.payload ->> 'productOverbooking', ''));

  -- Bubble ends a message with a blank line and a link to the recipient's
  -- own screen.
  if v_template.link is not null then
    v_content := v_content || chr(10) || chr(10) || v_template.link;
  end if;
  return v_content;
end;
$$;

comment on function public.compose_outbox_message(public.notification_outbox, text) is
  'One notification_outbox row''s WhatsApp text, as Bubble writes it (migration 0102): the row''s template with every placeholder filled — %FIRST_NAME% from p_first_name, %COMPANY% from the payload (else the recipient''s own name), %COMPANY_USER_FULL_NAME%, %ORDER_DETAILS% (compose_order_submitted_details for an office order message, or the customer''s private copy of it (order_submitted_copy, migration 0106), carrying its order, else compose_order_details_text), %NL%, %CURRENT_OPEN_BUSINESS_DAY% (message_trade_date; the date alone in the grower''s and transporter''s messages), %PICKUP_TIME%, %PRODUCT_NAME%, %PRODUCT_OVERBOOKING% — then a blank line and the template''s link, if it has one. The grower''s message drops "הודעה זו נשלחה גם למוביל" when the grower has no transporter. Raises P0002 for an unknown template. security invoker.';

revoke all on function public.compose_outbox_message(public.notification_outbox, text) from public, anon;
grant execute on function public.compose_outbox_message(public.notification_outbox, text) to authenticated, service_role;

-- 9. submit_order: 0102's body, changed only inside "if
-- v_direct_customer_submission": right after the office message, the same
-- payload is queued privately for the customer user who sent the order, through
-- enqueue_company_notification (section 3, capped 5 per 10 minutes).
-- Signature and grants are unchanged.
--
-- SECURITY: security definer ALLOWS this function to queue the messages as the
-- owner, which a customer's own row access cannot do (the outbox has no insert
-- policy for ordinary users). It PROTECTS AGAINST misuse through the caller
-- checks inside the body (from 0102 and earlier): a customer may only send
-- their own company's order, only while the shop is open; backoffice only on a
-- customer's behalf; everyone else, signed-out callers included, is refused.
-- The copy goes only to the calling user (auth.uid()), never to a person the
-- caller names.
create or replace function public.submit_order(
  p_trading_day_id uuid,
  p_lines jsonb,
  p_customer_company_id uuid default null,
  p_comment text default null
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
  -- 0101: the price a line records — see PRICE RECORD below.
  v_sees_prices boolean;
  v_price_type public.price_type;
  v_price numeric;
  v_price_range_from numeric;
  v_price_range_to numeric;
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

  -- 0101: PRICE RECORD. Every line this send writes records the product's
  -- price as the order's customer is shown it right now — its price type,
  -- and the price (מספר) or the range (טווח) that type shows; a תקליט type
  -- records the type alone. Recorded again on every send, a line the
  -- customer did not touch included (James, 2026-11-12: "every time the user
  -- submits an order"), so a line holds the price of its last save. Kept for
  -- the record: no screen shows it.
  --
  -- SECURITY: ALLOWS a line to record a price only when the order's customer
  -- may see it today — their company's can_see_product_prices AND the day's
  -- shop can_see_prices, the same test get_orderable_catalog_for_customer
  -- applies before it shows a customer a price (0072). On a staff send made
  -- on a customer's behalf it is still the customer's permission that
  -- counts, never staff's own (Bubble did the same). PROTECTS AGAINST a
  -- customer reading a price hidden from them: customers can read their own
  -- order lines straight from the API (daily_order_products_select_own), so
  -- a price recorded for a company without the permission, or on a day the
  -- shop hides prices, would hand them what 0056 and 0072 keep from them. A
  -- send that may not see prices records nothing and clears nothing: a line
  -- keeps whatever an earlier send recorded. Customers cannot write these
  -- columns themselves — they have no write policy on daily_order_products —
  -- so a record only ever comes from here (running as the function's owner)
  -- or from staff. A permission never set counts as "may not", and so does a
  -- day with no shop.
  select coalesce(c.can_see_product_prices, false) and coalesce(ds.can_see_prices, false)
  into v_sees_prices
  from public.companies c
  left join public.daily_shops ds on ds.trading_day_id = p_trading_day_id
  where c.id = v_customer_company_id;
  v_sees_prices := coalesce(v_sees_prices, false);

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

    -- 0101: the price this line records (PRICE RECORD above), read the way
    -- the shop shows it (formatPriceByType, packages/shared/src/price-type.ts):
    -- the product's own type — or, with none, what its numbers say: a price
    -- is מספר, both ends of a range טווח — and only the numbers that type
    -- shows. A number the type hides (a price left on a טווח product) is
    -- never recorded.
    v_price_type := null;
    v_price := null;
    v_price_range_from := null;
    v_price_range_to := null;
    if v_sees_prices then
      select
        coalesce(pv.price_type, case
          when pv.price is not null then 'fixed'::public.price_type
          when pv.price_range_from is not null and pv.price_range_to is not null then 'range'::public.price_type
        end),
        pv.price,
        pv.price_range_from,
        pv.price_range_to
      into v_price_type, v_price, v_price_range_from, v_price_range_to
      from public.product_varieties pv
      where pv.id = v_variety_id;

      v_price := case when v_price_type = 'fixed' then v_price end;
      v_price_range_from := case when v_price_type = 'range' then v_price_range_from end;
      v_price_range_to := case when v_price_type = 'range' then v_price_range_to end;
    end if;

    insert into public.daily_order_products (
      daily_order_id, product_variety_id, pallets_ordered, comment,
      price_type, price, price_range_from, price_range_to
    )
    values (
      v_order.id, v_variety_id, v_pallets, v_comment,
      v_price_type, v_price, v_price_range_from, v_price_range_to
    )
    on conflict (daily_order_id, product_variety_id)
    do update set pallets_ordered = excluded.pallets_ordered, comment = excluded.comment,
      -- 0101: a send that may see prices records the price again; one that
      -- may not leaves the line's record as it was.
      price_type = case when v_sees_prices then excluded.price_type else daily_order_products.price_type end,
      price = case when v_sees_prices then excluded.price else daily_order_products.price end,
      price_range_from = case when v_sees_prices then excluded.price_range_from else daily_order_products.price_range_from end,
      price_range_to = case when v_sees_prices then excluded.price_range_to else daily_order_products.price_range_to end,
      updated_at = now()
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
  --
  -- 0101: a zeroed line keeps its price record — the price of its last save.
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
  set status = 'submitted', submitted_at = now(), updated_at = now(),
      -- 0093: the order comment ("הערה כללית"). Not sent keeps the stored
      -- comment (an older copy of the order screen doesn't know the input);
      -- empty text clears it; other text is saved trimmed.
      comment = case when p_comment is null then comment else nullif(btrim(p_comment), '') end
  where id = v_order.id
  returning * into v_order;

  insert into public.order_submission_logs (daily_order_id, submitted_by, snapshot)
  values (v_order.id, (select auth.uid()), p_lines);

  -- id 6.
  if v_direct_customer_submission then
    select name into v_customer_company_name from public.companies where id = v_customer_company_id;
    perform public.enqueue_backoffice_notification(
      p_trading_day_id, 'order_submitted',
      -- 0102: the order and who sent it, for the message to list the order as
      -- it stands and name the sender (Bubble's main alert 6).
      jsonb_build_object(
        'tradeDate', v_trade_date, 'lines', '[]'::jsonb, 'companyName', v_customer_company_name,
        'dailyOrderId', v_order.id,
        'submittedByName', (select p.display_name from public.profiles p where p.user_id = (select auth.uid()))
      )
    );
    -- 0106: in Bubble the customer user who sent the order gets the same text
    -- privately. Only here, on a direct customer submission: when the office
    -- orders on a customer's behalf nobody is messaged. The row lists its one
    -- person (0104), so it never goes to the company's group.
    perform public.enqueue_company_notification(
      p_trading_day_id, 'customer', v_customer_company_id, 'order_submitted_copy',
      jsonb_build_object(
        'tradeDate', v_trade_date, 'lines', '[]'::jsonb, 'companyName', v_customer_company_name,
        'dailyOrderId', v_order.id,
        'submittedByName', (select p.display_name from public.profiles p where p.user_id = (select auth.uid()))
      ),
      array[(select auth.uid())]
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

comment on function public.submit_order(uuid, jsonb, uuid, text) is
  'Customer-only for their own company (p_customer_company_id omitted). Backoffice-only when p_customer_company_id is supplied. One transaction: upserts-and-prunes daily_order_products from p_lines, sets the order to submitted and stamps submitted_at, writes one order_submission_logs row (attributed to whoever actually called this), and — only on a direct customer submission, never the backoffice-on-behalf-of path — enqueues one order_submitted notification to backoffice (id 6) and one order_submitted_copy for the customer user who sent it, privately (migration 0106), and rejects (P0008) any line raised above max_orderable_for_customer() for that variety (a line kept at, or lowered from, its saved quantity is accepted even when stock has since dropped below it — migration 0068). On a direct customer submission, a line for a product on the calling user''s own blocked list (profile_blocked_products) is ignored if sent and never pruned: it is left exactly as it was (migration 0072). Also computes, for every variety this call''s lines could have pushed across a threshold, whether it just became fully-ordered-with-overbooking-room (stock_overbooking_reached, id 10) or fully-exhausted (stock_fully_exhausted, id 11) — live, in this same transaction, never via a stored out-of-stock list or trigger. A pruned line that an arrangement_records row points at is zeroed rather than deleted, so re-saving an order can no longer cascade away the distributor''s allocations. Sends for one trading day run one at a time (a transaction-level advisory lock, 0068), so two customers can never both take the same last pallets. Raises P0007 if the trading day is closed, or — for a customer''s own order — if the shop is not open (phase shop_open; migration 0071, which also reads the phase `for share` so a send and close_shop can never cross), P0008 if a line references a variety not in today''s shop, has a negative pallet count, or (direct customer submissions only) raises a line above the per-customer cap. p_comment (0093): the order-level comment (הערה כללית) — null keeps the stored comment, empty text clears it, other text is saved trimmed; it is written under the same checks as the lines and is not part of the submission log snapshot. Price record (0101): every line a send writes records the product''s price as the order''s customer is shown it — price_type, plus price for fixed (מספר) or price_range_from/price_range_to for range (טווח), the type alone for a record_* (תקליט) type; with no type, a price reads as fixed and both ends of a range as range — but only when that customer''s company has can_see_product_prices and the day''s shop can_see_prices (on a staff send on their behalf too). It is recorded again on every such send, untouched lines included; a send that may not see prices records nothing and clears nothing. A zeroed or blocked line keeps its record.';
