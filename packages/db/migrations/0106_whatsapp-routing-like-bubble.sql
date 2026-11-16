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
