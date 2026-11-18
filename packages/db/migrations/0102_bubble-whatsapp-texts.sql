-- WhatsApp messages as Bubble writes them (James, 2026-11-13).
--
-- James asked for Ori's WhatsApp texts to be checked against the Bubble app
-- ("Ori and the Bananas", read-only — nothing was changed there) and made the
-- same. Bubble keeps its texts as eleven `main alert` rows; its workflows fill
-- the placeholders and send. This migration copies those eleven texts into
-- notification_templates WORD FOR WORD and fills the placeholders the way
-- Bubble's live workflows do, as read from the live app on 2026-11-13:
--
--   - %CURRENT_OPEN_BUSINESS_DAY%: the first letter of the day's Hebrew name,
--     a space, dd.mm.yy ("ח 12.11.26" — ראשון ר, שני ש, שלישי ש, רביעי ר,
--     חמישי ח, שישי ש, שבת ש; seen in a message Bubble sent). In the grower's
--     and the transporter's messages Bubble writes the date alone, after a
--     space (" 12.11.26"), so "לתאריך" is followed by two spaces there.
--   - %ORDER_DETAILS%, three layouts:
--       the customer's end of day (main alert 9), a line per allocation:
--         "<family> <variety> <sizes>  |  מחיר: <price>  |  כמות: <n> <grower>"
--       the office's new order (main alert 6), the order as it stands when
--       the message goes out, then the order's general comment:
--         "<family> <variety> <sizes>  |  מחיר: <price>  |  כמות: <n> (<comment>)"
--         "הערה כללית:<tab> <comment>"
--       the grower's and the transporter's (main alerts 8 and 7), grouped
--       under each customer's name in bold (WhatsApp's *...*):
--         "*<customer>*" then "<n> <family><tab>  <variety> <sizes>" per line
--     The family is left out when the variety has the same name. A price is
--     written by its type: מספר "₪<price>", טווח "₪<high> - ₪<low>", a תקליט
--     type its own name.
--   - %COMPANY_USER_FULL_NAME% (new): who sent the order. submit_order now
--     puts the order's id and the sender's name on the office message.
--   - a blank line and a link to the recipient's own screen at the end, where
--     Bubble has one — pointing at Ori: https://ori-claude-web.vercel.app/...
--
-- James's choices (2026-11-13): copy Bubble, but fix two of its glitches —
--   1. half pallets are written as they are (Bubble rounds them to a whole
--      number in the grower's and the transporter's lists);
--   2. the grower's message ends "הודעה זו נשלחה גם למוביל" only when the
--      grower has a transporter (Bubble writes it to every grower).
-- Who receives each message is unchanged: only the texts change.
--
-- To point the links at another address later, one statement:
--   update public.notification_templates
--   set link = replace(link, 'https://ori-claude-web.vercel.app', 'https://<new address>')
--   where link like 'https://ori-claude-web.vercel.app/%';
--
-- Rollout: run after 0101 (submit_order below is 0101's, with one change).
-- The web app does not change. whatsapp-dispatch needs no redeploy:
-- resolve_outbox_dispatch and resolve_outbox_preview keep their arguments and
-- what they return. A message queued before this runs and sent after it gets
-- the new text; an office order message queued before it has no order to
-- list, so it goes out without the lines. Safe to run again.

-- 1. The day, as Bubble writes it in a message.
create or replace function public.message_trade_date(p_date date, p_with_weekday boolean)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_date is null then ''
    when p_with_weekday then
      (array['ר', 'ש', 'ש', 'ר', 'ח', 'ש', 'ש'])[extract(dow from p_date)::int + 1] || ' ' || to_char(p_date, 'DD.MM.YY')
    else ' ' || to_char(p_date, 'DD.MM.YY')
  end
$$;

comment on function public.message_trade_date(date, boolean) is
  'A trading day as Bubble writes it in a WhatsApp message (migration 0102): the first letter of the day''s Hebrew name, a space and dd.mm.yy ("ח 12.11.26"); without the day, a space and dd.mm.yy (" 12.11.26"), as in Bubble''s grower and transporter messages. Empty for no date. Pure.';

-- 2. A price by its type, as Bubble writes it in a message line.
create or replace function public.message_price_text(p_price_type text, p_price numeric, p_from numeric, p_to numeric)
returns text
language sql
immutable
set search_path = public
as $$
  with t as (
    -- No type (a line recorded before 0100): a price reads as מספר, both
    -- ends of a range as טווח — 0083's rule.
    select coalesce(
      p_price_type,
      case when p_price is not null then 'fixed' when p_from is not null and p_to is not null then 'range' end
    ) as kind
  )
  select case
    when kind = 'fixed' then case when p_price is not null then '₪' || trim_scale(p_price)::text end
    when kind = 'range' then
      case when p_from is not null and p_to is not null then '₪' || trim_scale(p_to)::text || ' - ₪' || trim_scale(p_from)::text end
    -- A תקליט type: its own name — there is no number.
    else public.price_type_label(kind)
  end
  from t
$$;

comment on function public.message_price_text(text, numeric, numeric, numeric) is
  'A price by its type, as Bubble writes it in a WhatsApp message (migration 0102): מספר "₪<price>", טווח "₪<high> - ₪<low>", a תקליט type its own name (price_type_label). With no type, a price reads as מספר and both ends of a range as טווח. NULL when there is nothing to write (no number for the type). Pure.';

-- 3. A product's name in a message line.
create or replace function public.message_product_name(p_family text, p_variety text, p_sizes text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when p_family is distinct from p_variety then coalesce(p_family, '') || ' ' else '' end
    || coalesce(p_variety, '')
    || case when coalesce(p_sizes, '') <> '' then ' ' || p_sizes else '' end
$$;

comment on function public.message_product_name(text, text, text) is
  'A product as Bubble names it in a WhatsApp message line (migration 0102): "<family> <variety> <sizes>", the family left out when the variety has the same name, the sizes when there are none. Pure.';

-- 4. The lines of a closing message, in Bubble's two layouts.
create or replace function public.compose_order_details_text(p_payload jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  with lines as (
    select
      line,
      line ->> 'familyName' as family,
      line ->> 'varietyName' as variety,
      line ->> 'varietySizes' as sizes,
      trim_scale((line ->> 'quantityPallets')::numeric)::text as qty,
      line ->> 'customerCompanyName' as customer,
      line ->> 'growerCompanyName' as grower
    from jsonb_array_elements(coalesce(p_payload -> 'lines', '[]'::jsonb)) as line
  ),
  -- The grower's and the transporter's (main alerts 8 and 7): grouped under
  -- each customer's name in bold. Half pallets as they are (Bubble rounds
  -- them — fixed, James 2026-11-13).
  by_customer as (
    select
      customer,
      '*' || customer || '*' || chr(10) || string_agg(
        qty || ' '
          || case when family is distinct from variety then coalesce(family, '') || chr(9) || ' ' else '' end
          || ' ' || coalesce(variety, '') || ' ' || coalesce(sizes, ''),
        chr(10) order by family, variety
      ) as block
    from lines
    where customer is not null
    group by customer
  )
  select case
    when exists (select 1 from lines where customer is not null) then
      (select string_agg(block, chr(10) order by customer) from by_customer)
    else
      -- The customer's end of day (main alert 9): a line per allocation. A
      -- line carries a price only when the customer may see it (0083).
      (select string_agg(
          public.message_product_name(family, variety, sizes) || '  |  '
            || coalesce('מחיר: ' || public.message_price_text(
                 line ->> 'priceType', (line ->> 'price')::numeric,
                 (line ->> 'priceRangeFrom')::numeric, (line ->> 'priceRangeTo')::numeric) || '  |  ', '')
            || 'כמות: ' || qty || ' ' || coalesce(grower, ''),
          chr(10) order by family, variety, grower
        )
       from lines)
  end
$$;

comment on function public.compose_order_details_text(jsonb) is
  'The %ORDER_DETAILS% of a closing message, in Bubble''s layouts (migration 0102). Lines naming a customer (customerCompanyName — the grower''s and the transporter''s messages, main alerts 8 and 7): grouped under each customer''s name in bold, one line per product "<pallets> <family><tab>  <variety> <sizes>", half pallets as they are. Lines naming a grower (growerCompanyName — the customer''s end of day, main alert 9): one line per allocation "<product>  |  מחיר: <price>  |  כמות: <pallets> <grower>", the price only when the line carries one. NULL for no lines. Pure.';

-- 5. The office's new-order message: the order as it stands.
create or replace function public.compose_order_submitted_details(p_daily_order_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
      (select string_agg(
          public.message_product_name(pf.name, pv.name, pv.sizes) || '  |  '
            || coalesce('מחיר: ' || public.message_price_text(
                 dop.price_type::text, dop.price, dop.price_range_from, dop.price_range_to) || '  |  ', '')
            || 'כמות: ' || trim_scale(dop.pallets_ordered)::text || ' '
            || coalesce('(' || nullif(dop.comment, '') || ')', ''),
          chr(10) order by pf.name, pv.name
        )
       from public.daily_order_products dop
       join public.product_varieties pv on pv.id = dop.product_variety_id
       join public.product_families pf on pf.id = pv.family_id
       where dop.daily_order_id = p_daily_order_id
         and dop.pallets_ordered > 0),
      '')
    || chr(10)
    || coalesce(
      (select 'הערה כללית:' || chr(9) || ' ' || o.comment
       from public.daily_orders o
       where o.id = p_daily_order_id and nullif(o.comment, '') is not null),
      '')
$$;

comment on function public.compose_order_submitted_details(uuid) is
  'The %ORDER_DETAILS% of the office''s new-order message, Bubble''s main alert 6 (migration 0102): the order as it stands — one line per product with pallets, "<product>  |  מחיר: <price>  |  כמות: <pallets> (<comment>)", the price being the one recorded on the line for its customer (0101), then a line break and "הערה כללית:<tab> <comment>" when the order has a general comment. security invoker: a caller sees only the order lines their own row-level security allows.';

-- 6. One message, composed: the template, its placeholders, the link.
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
    when p_row.template_key = 'order_submitted' and p_row.payload ? 'dailyOrderId'
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
  'One notification_outbox row''s WhatsApp text, as Bubble writes it (migration 0102): the row''s template with every placeholder filled — %FIRST_NAME% from p_first_name, %COMPANY% from the payload (else the recipient''s own name), %COMPANY_USER_FULL_NAME%, %ORDER_DETAILS% (compose_order_submitted_details for an office order message carrying its order, else compose_order_details_text), %NL%, %CURRENT_OPEN_BUSINESS_DAY% (message_trade_date; the date alone in the grower''s and transporter''s messages), %PICKUP_TIME%, %PRODUCT_NAME%, %PRODUCT_OVERBOOKING% — then a blank line and the template''s link, if it has one. The grower''s message drops "הודעה זו נשלחה גם למוביל" when the grower has no transporter. Raises P0002 for an unknown template. security invoker.';

-- SECURITY: ALLOWS signed-in sessions and the WhatsApp dispatcher (the
-- service role) to run the five functions above — resolve_outbox_dispatch and
-- resolve_outbox_preview call them as their own caller (security invoker),
-- and service_role is granted by name because a fresh Supabase stack gives it
-- no execute rights of its own once PUBLIC's are revoked. PROTECTS AGAINST a
-- signed-out visitor calling them, and keeps them out of PUBLIC. The two that
-- read data are security invoker, so row-level security still decides what a
-- caller sees: a customer only their own order's lines, a grower none — they
-- can never show one company's order to another.
revoke all on function public.message_trade_date(date, boolean) from public, anon;
revoke all on function public.message_price_text(text, numeric, numeric, numeric) from public, anon;
revoke all on function public.message_product_name(text, text, text) from public, anon;
revoke all on function public.compose_order_submitted_details(uuid) from public, anon;
revoke all on function public.compose_outbox_message(public.notification_outbox, text) from public, anon;
grant execute on function public.message_trade_date(date, boolean) to authenticated, service_role;
grant execute on function public.message_price_text(text, numeric, numeric, numeric) to authenticated, service_role;
grant execute on function public.message_product_name(text, text, text) to authenticated, service_role;
grant execute on function public.compose_order_submitted_details(uuid) to authenticated, service_role;
grant execute on function public.compose_outbox_message(public.notification_outbox, text) to authenticated, service_role;

-- 7. The two entry points the dispatcher calls: same arguments, same result
-- columns as before (so the deployed whatsapp-dispatch keeps working); the
-- text now comes from compose_outbox_message. CREATE OR REPLACE with the same
-- arguments keeps their grants.
--
-- SECURITY: unchanged from 0081 — security invoker, so the caller's own
-- row-level security applies. ALLOWS the dispatcher (service-role key) and a
-- backoffice session to resolve any row. PROTECTS AGAINST any other signed-in
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
begin
  select * into v_row from public.notification_outbox where id = p_outbox_id;
  if not found then
    raise exception 'NOT_FOUND: notification_outbox row % does not exist', p_outbox_id using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.notification_templates where template_key = v_row.template_key) then
    raise exception 'NOT_FOUND: notification template % does not exist', v_row.template_key using errcode = 'P0002';
  end if;

  select * into v_company from public.companies where id = v_row.recipient_company_id;

  if v_company.whatsapp_group_id is not null and v_company.whatsapp_group_id <> '' then
    -- A WhatsApp group: one message, addressed to the company by name.
    return query select v_company.whatsapp_group_id, true, public.compose_outbox_message(v_row, v_company.name);
  else
    -- Each user with a number Ori can message, by their first name.
    return query
    select
      public.whatsapp_personal_number(p.phone_number),
      false,
      public.compose_outbox_message(v_row, split_part(p.display_name, ' ', 1))
    from public.profiles p
    where p.company_id = v_row.recipient_company_id
      and public.whatsapp_personal_number(p.phone_number) is not null
    order by p.user_id;
  end if;
end;
$$;

comment on function public.resolve_outbox_dispatch(uuid) is
  'Resolves one notification_outbox row into its actual send targets: one row (the bare WhatsApp group id, is_group = true) if the recipient company has whatsapp_group_id set, otherwise one row per user with a phone number on file (is_group = false, addressed by country code and number — whatsapp_personal_number, 0077), in user order. A user whose number cannot be read as a phone number is skipped. The text is compose_outbox_message''s (Bubble''s wording and layouts, migration 0102): %FIRST_NAME% is the company''s name for a group, else the user''s first name. Raises P0002 if the outbox row or its template_key does not resolve.';

-- SECURITY: as resolve_outbox_dispatch above — security invoker, so only a
-- caller whose own row-level security shows them the outbox row (the
-- dispatcher, a backoffice session) gets a preview; anyone else stops at
-- NOT_FOUND.
create or replace function public.resolve_outbox_preview(p_outbox_id uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.notification_outbox;
  v_company public.companies;
begin
  select * into v_row from public.notification_outbox where id = p_outbox_id;
  if not found then
    raise exception 'NOT_FOUND: notification_outbox row % does not exist', p_outbox_id using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.notification_templates where template_key = v_row.template_key) then
    raise exception 'NOT_FOUND: notification template % does not exist', v_row.template_key using errcode = 'P0002';
  end if;

  select * into v_company from public.companies where id = v_row.recipient_company_id;
  return public.compose_outbox_message(v_row, v_company.name);
end;
$$;

comment on function public.resolve_outbox_preview(uuid) is
  'Dev-only preview: composes one notification_outbox row''s message once, addressed to the recipient company by name, with compose_outbox_message (Bubble''s wording and layouts, migration 0102), for whatsapp-dispatch''s dev environment to send to notification_settings.whatsapp_dev_override_phone. Raises P0002 if the outbox row or its template_key does not resolve.';

-- 8. submit_order: the office's new-order message carries the order and who
-- sent it, so it can list the order as it stands and name the sender. 0101's
-- body verbatim apart from the lines marked "0102".

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

-- 9. The eleven texts: Bubble's `main alert` 1-11 word for word (read from
-- the live app, 2026-11-13), and the link each message ends with. Bubble's
-- main alerts 1 and 2 are the same text; 7 is the transporter's, 8 the
-- grower's. The grower's, the transporter's and the stock messages have no
-- link, as in Bubble.
--
-- First, every template this section rewrites must exist: refuse to run on
-- a database where one is missing rather than change only some texts.
do $$
begin
  if (select count(*) from public.notification_templates where template_key in ('business_day_open_grower', 'pick_reminder', 'pick_updated', 'shop_open', 'order_reminder', 'order_submitted', 'close_arrangement_grower_transporter', 'close_arrangement_grower', 'close_arrangement_customer', 'stock_overbooking_reached', 'stock_fully_exhausted')) <> 11 then
    raise exception 'notification_templates is missing one of the eleven WhatsApp templates 0102 rewrites';
  end if;
end
$$;

-- main alert 1
update public.notification_templates
set content = E'שלום %FIRST_NAME%. אנא עדכנו הערכת קטיף ליום %CURRENT_OPEN_BUSINESS_DAY% ',
    link = 'https://ori-claude-web.vercel.app/grower/picks',
    updated_at = now()
where template_key = 'business_day_open_grower';

-- main alert 2
update public.notification_templates
set content = E'שלום %FIRST_NAME%. אנא עדכנו הערכת קטיף ליום %CURRENT_OPEN_BUSINESS_DAY% ',
    link = 'https://ori-claude-web.vercel.app/grower/picks',
    updated_at = now()
where template_key = 'pick_reminder';

-- main alert 3
update public.notification_templates
set content = E'שלום. %COMPANY% עדכן את הערכת הקטיף ליום %CURRENT_OPEN_BUSINESS_DAY% ',
    link = 'https://ori-claude-web.vercel.app/backoffice/distributor-grower',
    updated_at = now()
where template_key = 'pick_updated';

-- main alert 4
update public.notification_templates
set content = E'שלום %FIRST_NAME%. החנות כעת פתוחה להזמנות.',
    link = 'https://ori-claude-web.vercel.app/customer/order',
    updated_at = now()
where template_key = 'shop_open';

-- main alert 5
update public.notification_templates
set content = E'שלום %FIRST_NAME%. זוהי תזכורת לשלוח הזמנה ליום %CURRENT_OPEN_BUSINESS_DAY% ',
    link = 'https://ori-claude-web.vercel.app/customer/order',
    updated_at = now()
where template_key = 'order_reminder';

-- main alert 6
update public.notification_templates
set content = E'שלום %FIRST_NAME%. \n%COMPANY% שלחו הזמנה על ידי %COMPANY_USER_FULL_NAME%.\nלהלן מצב ההזמנה הנוכחי שלהם:\n\n%ORDER_DETAILS%',
    link = 'https://ori-claude-web.vercel.app/backoffice/distributor-customer',
    updated_at = now()
where template_key = 'order_submitted';

-- main alert 7
update public.notification_templates
set content = E'היי, %NL%\nלהלן הסידור של %COMPANY% לתאריך %CURRENT_OPEN_BUSINESS_DAY%.  %NL%\n%ORDER_DETAILS% %NL%\nהמשטחים יהיו מוכנים לאיסוף ב %PICKUP_TIME%',
    link = null,
    updated_at = now()
where template_key = 'close_arrangement_grower_transporter';

-- main alert 8
update public.notification_templates
set content = E'היי, %NL%\nלהלן הסידור של %COMPANY% לתאריך %CURRENT_OPEN_BUSINESS_DAY%. %NL%\n%ORDER_DETAILS% %NL%\nהודעה זו נשלחה גם למוביל',
    link = null,
    updated_at = now()
where template_key = 'close_arrangement_grower';

-- main alert 9
update public.notification_templates
set content = E'שלום %FIRST_NAME%. להלן המוצרים שהזמנת ושתקבל לתאריך %CURRENT_OPEN_BUSINESS_DAY% מהמגדלים השונים: %NL%%ORDER_DETAILS%',
    link = 'https://ori-claude-web.vercel.app/customer/history',
    updated_at = now()
where template_key = 'close_arrangement_customer';

-- main alert 10
update public.notification_templates
set content = E'שלום %FIRST_NAME%. כל המשטחים שנקטפו עבור %PRODUCT_NAME% הוזמנו. האפשרות להזמין תשאר פתוחה לעוד %PRODUCT_OVERBOOKING% משטחים עבור מוצר זה.',
    link = null,
    updated_at = now()
where template_key = 'stock_overbooking_reached';

-- main alert 11
update public.notification_templates
set content = E'שלום %FIRST_NAME%. כל המשטחים + אוברבוקינג עבור %PRODUCT_NAME% הוזמנו. לא ניתן יותר להזמין ממוצר זה במערכת.',
    link = null,
    updated_at = now()
where template_key = 'stock_fully_exhausted';
