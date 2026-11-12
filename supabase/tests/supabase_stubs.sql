-- Minimal stand-ins for Supabase's built-in schemas, so the migration can be tested on plain Postgres.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema vault; create schema storage;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role; grant execute on function auth.jwt() to anon, authenticated, service_role;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, secret text);
create function vault.create_secret(s text, n text) returns uuid language sql as $$ insert into vault.secrets(secret, name) values (s, n) returning id $$;
create function vault.update_secret(i uuid, s text) returns void language sql as $$ update vault.secrets set secret = s where id = i $$;
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role; grant select on storage.objects to authenticated;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
