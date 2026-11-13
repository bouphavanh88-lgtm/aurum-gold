-- AURUM database (Supabase). Run once in a fresh project's SQL editor,
-- then insert the server token:
--   insert into public.aurum_secret (id, token) values (1, '<same value as AURUM_DB_TOKEN in Vercel>');
-- Every request from api/_lib.js sends that token in the x-aurum-token header;
-- row level security only lets requests with the right token through.

create table if not exists public.aurum_kv (
  path text primary key,
  data jsonb,
  updated_at timestamptz default now()
);

create table if not exists public.aurum_secret (
  id integer primary key,
  token text
);

create or replace function public.aurum_ok() returns boolean
language sql stable security definer set search_path to 'public' as $$
  select coalesce(
    (current_setting('request.headers', true)::json ->> 'x-aurum-token')
      = (select token from public.aurum_secret where id = 1),
    false)
$$;

alter table public.aurum_kv enable row level security;
alter table public.aurum_secret enable row level security;   -- no policies: never readable through the API

drop policy if exists aurum_kv_all on public.aurum_kv;
create policy aurum_kv_all on public.aurum_kv for all to anon, authenticated
  using (public.aurum_ok()) with check (public.aurum_ok());

-- Only the row operations the app uses. TRUNCATE is left out on purpose:
-- it ignores row level security, so granting it would let anyone empty the table.
revoke all on public.aurum_kv, public.aurum_secret from anon, authenticated;
grant select, insert, update, delete on public.aurum_kv to anon, authenticated;
revoke execute on function public.aurum_ok() from public;
grant execute on function public.aurum_ok() to anon, authenticated;
