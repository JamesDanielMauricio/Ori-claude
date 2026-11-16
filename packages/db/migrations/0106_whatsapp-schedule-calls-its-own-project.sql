-- 0106 — the WhatsApp schedule calls its OWN project's sender.
--
-- 0047 wrote production's address into the 10-minute safety-net schedule:
--   https://zvzqfjrxknxigddkwlir.supabase.co/functions/v1/whatsapp-dispatch
-- That was fine with one database. Now there is a dev project too, built by
-- running every migration from 0000, so without this file dev's schedule
-- would call PRODUCTION's sender. This rewrites the schedule to read the
-- address from Vault, where each project keeps its own:
--
--   prod:  https://zvzqfjrxknxigddkwlir.supabase.co
--   dev:   https://owjgzyxuldmgvwxnhrom.supabase.co
--
-- The "send right away" trigger (0079, request_whatsapp_dispatch_now) runs
-- this same schedule command, so it follows the new address too, with no
-- change of its own.
--
-- BEFORE RUNNING THIS ON A PROJECT THAT SENDS WHATSAPP (production), store
-- that project's address once in the SQL Editor:
--
--   select vault.create_secret('https://zvzqfjrxknxigddkwlir.supabase.co', 'project_url');
--
-- On dev, run the same line with dev's address when you set up dev's
-- WhatsApp. Until then dev's schedule simply does nothing (see below).
--
-- Safe to run again: cron.schedule replaces the job with the same name.

-- SECURITY: refuse to run where the schedule is wired to send (its Vault key
-- exists) but the address isn't stored yet. Without this guard the new
-- command below would quietly find no address and stop sending — on
-- production that means WhatsApp messages stop going out with no error
-- anywhere. Failing here instead keeps the old schedule untouched until the
-- address is added. Projects without the key (a fresh dev project, CI's
-- throwaway database) aren't sending anyway, so they pass.
do $$
begin
  if exists (select 1 from vault.decrypted_secrets where name = 'whatsapp_dispatch_service_role_key')
     and not exists (select 1 from vault.decrypted_secrets where name = 'project_url') then
    raise exception
      'Vault secret "project_url" is missing. Run: select vault.create_secret(''https://<this project ref>.supabase.co'', ''project_url''); then run this migration again.';
  end if;
end;
$$;

-- SECURITY: both the address and the service-role key are read from Vault by
-- NAME, never written in this file (a migration is committed to a public
-- repo). The "from … where" form means a project missing either secret makes
-- NO call at all — no 401 noise, and above all no call to some other
-- project's sender.
select cron.schedule(
  'whatsapp-dispatch-safety-net',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := rtrim(project_url.decrypted_secret, '/') || '/functions/v1/whatsapp-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key.decrypted_secret
    ),
    body := '{}'::jsonb
  )
  from vault.decrypted_secrets project_url, vault.decrypted_secrets service_key
  where project_url.name = 'project_url'
    and service_key.name = 'whatsapp_dispatch_service_role_key';
  $$
);
