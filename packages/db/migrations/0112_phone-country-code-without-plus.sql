-- Phone numbers typed with their country code but without "+" (James,
-- 2026-11-25: "can we make it so that the app supports 0 or country code
-- (with and without the +)?"). The dev test phone on live was stored as
-- 639171234567 — a Philippine number with its country code and no + — and the
-- rule read it as Israeli, found it invalid, and the dispatcher refused to send
-- to it ("test phone configured: no").
--
-- The rule (0077's; packages/shared/src/phone.ts) now reads a number typed
-- without + or 00 as Israeli whenever it is a whole Israeli number — with or
-- without its zero, exactly as before — and only when it is not, as a foreign
-- number by its own first digits: when it has 10 to 15 digits, does not start
-- with 0, and does not start with 972 (Israel's code — the number was just
-- found not to be Israeli). It is stored as before: + and the digits. Every
-- number the old rule accepted reads exactly as before; this only lets through
-- numbers it refused. The refusal message no longer asks for a +.
--
-- The same rule is in packages/shared/src/phone.ts and
-- supabase/functions/whatsapp-dispatch/phone.ts; packages/shared/src/
-- phone-cases.json holds the examples all three are tested against.
--
-- Rollout: run on dev by hand first; on live it runs on merge. Messages to
-- real people are addressed through this rule (whatsapp_personal_number). The
-- hand-deployed whatsapp-dispatch function reads the dev test phone with its
-- own copy, so redeploy it — or save the test phone again, which stores it as
-- +<digits>, a form the deployed copy already reads. Numbers already stored are
-- not rewritten. Every statement is create-or-replace, so it is safe to run
-- again.

-- The phone rule, 0077's with one step added at the end (marked "0112").
-- SECURITY: `set search_path = ''` ALLOWS nothing extra; it makes every name in
-- the body resolve only as written (built-ins only — this reads no table).
-- PROTECTS AGAINST a caller's search_path pointing a function this calls at an
-- object of their own, so the stored form of every phone number is decided by
-- this rule alone.
create or replace function public.normalize_phone_number(p_input text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_allowed constant text := '0123456789 +()./-'
    || chr(160)                                                                    -- no-break space
    || chr(8208) || chr(8209) || chr(8210) || chr(8211) || chr(8212) || chr(8213) -- dashes
    || chr(8206) || chr(8207)                                                      -- LRM, RLM
    || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238)               -- LRE, RLE, PDF, LRO, RLO
    || chr(8294) || chr(8295) || chr(8296) || chr(8297);                           -- LRI, RLI, FSI, PDI
  v_compact text;
  v_international boolean;
  v_digits text;
  v_full text;
  v_local text;
  v_bare text;
begin
  if p_input is null or p_input = '' then
    return null;
  end if;
  -- Anything but digits and the allowed characters — a letter, say: refused.
  if translate(p_input, v_allowed, '') <> '' then
    return null;
  end if;
  -- Digits and "+" only. A "+" anywhere but in front is not a phone number.
  v_compact := regexp_replace(p_input, '[^0-9+]', '', 'g');
  if strpos(substr(v_compact, 2), '+') > 0 then
    return null;
  end if;
  v_international := v_compact like '+%' or v_compact like '00%';
  v_digits := regexp_replace(
    case when v_international then replace(p_input, '(0)', '') else p_input end,
    '[^0-9]', '', 'g'
  );
  if v_digits = '' then
    return null;
  end if;

  -- The number with its country code, when it was written with one.
  if v_compact like '+%' then
    v_full := v_digits;
  elsif v_digits like '00%' then
    v_full := substr(v_digits, 3);
  elsif v_digits like '972%' and length(v_digits) >= 11 then
    v_full := v_digits;
  end if;

  if v_full is not null and v_full not like '972%' then
    return case when v_full ~ '^[1-9][0-9]{6,14}$' then '+' || v_full end;
  end if;

  -- Israeli: after +972 / 00972 / 972, or written locally. "+972 (0)50…" and
  -- "050…" keep their zero; "+972 50…" and "50…" get one.
  v_local := case when v_full is not null then substr(v_full, 4) else v_digits end;
  if v_local not like '0%' then
    v_local := '0' || v_local;
  end if;
  if v_local ~ '^0([23489][0-9]{7}|[57][0-9]{8})$' then
    return v_local;
  end if;

  -- 0112: typed without + or 00, and not an Israeli number — a foreign number
  -- with its country code but no + (639171234567), when it is a whole one:
  -- 10 to 15 digits, so a short mistyped Israeli number is refused rather than
  -- read as some other country's. Never one starting with 972 — that is
  -- Israel's code, and the number was just found not to be Israeli. "(0)" is
  -- the trunk zero here too.
  if v_full is null then
    v_bare := regexp_replace(replace(p_input, '(0)', ''), '[^0-9]', '', 'g');
    if v_bare not like '972%' and v_bare ~ '^[1-9][0-9]{9,14}$' then
      return '+' || v_bare;
    end if;
  end if;
  return null;
end;
$$;

comment on function public.normalize_phone_number(text) is
  'The stored form of a phone number, or null when the input is not one Ori can message: an Israeli number as local digits with its leading zero (0501234567, 031234567); a foreign number as + and 7-15 digits (+12125551234) — typed with + or 00 and its country code, or (migration 0112) with its country code alone when it is not an Israeli number and has 10-15 digits not starting with 0 or 972 (639171234567 -> +639171234567). A number that is a whole Israeli number is always read as Israeli. Mirrors packages/shared/src/phone.ts exactly (shared examples: packages/shared/src/phone-cases.json). Pure — reads no table.';

-- Every save of a profile's phone number goes through the rule — 0077's
-- trigger function, with the refusal message no longer asking for a +.
-- Only the value being written is judged: an old, already-invalid number
-- that is saved back unchanged is left alone, so a save of the user's other
-- fields (which re-sends the number) is not refused for it.
-- SECURITY: `set search_path = ''` ALLOWS nothing extra (it runs as the saving
-- user, under their own row rules). PROTECTS AGAINST a caller's search_path
-- swapping the phone rule this calls for an object of their own, which could
-- let an unreachable number be stored.
create or replace function public.profiles_tidy_phone_number()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_tidy text;
begin
  if new.phone_number is null or btrim(new.phone_number) = '' then
    new.phone_number := null;
    return new;
  end if;
  v_tidy := public.normalize_phone_number(new.phone_number);
  if v_tidy is not null then
    new.phone_number := v_tidy;
  elsif tg_op = 'INSERT' or new.phone_number is distinct from old.phone_number then
    raise exception 'INVALID_PHONE: מספר הטלפון אינו תקין. יש להזין מספר ישראלי (למשל 050-1234567) או מספר מחו״ל עם קידומת המדינה.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

-- The dev test phone (notification_settings.whatsapp_dev_override_phone, 0045),
-- where every dev-mode message goes: same rule, same form, same message.
-- SECURITY: as profiles_tidy_phone_number above — `set search_path = ''`
-- ALLOWS nothing extra and PROTECTS AGAINST the phone rule being swapped by a
-- caller's search_path.
create or replace function public.notification_settings_tidy_dev_phone()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_tidy text;
begin
  if new.whatsapp_dev_override_phone is null or btrim(new.whatsapp_dev_override_phone) = '' then
    new.whatsapp_dev_override_phone := null;
    return new;
  end if;
  v_tidy := public.normalize_phone_number(new.whatsapp_dev_override_phone);
  if v_tidy is not null then
    new.whatsapp_dev_override_phone := v_tidy;
  elsif tg_op = 'INSERT' or new.whatsapp_dev_override_phone is distinct from old.whatsapp_dev_override_phone then
    raise exception 'INVALID_PHONE: מספר הטלפון אינו תקין. יש להזין מספר ישראלי (למשל 050-1234567) או מספר מחו״ל עם קידומת המדינה.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;
