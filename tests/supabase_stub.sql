-- Minimal stand-in for the parts of Supabase the schema relies on (local testing only).
create role anon nologin;
create role authenticated nologin;
grant usage on schema public to anon, authenticated;
create schema auth;
grant usage on schema auth to anon, authenticated;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select jsonb_build_object('sub', current_setting('request.jwt.claim.sub', true),
                            'email', current_setting('request.jwt.claim.email', true)) $$;
grant execute on all functions in schema auth to anon, authenticated;
create schema storage;
grant usage on schema storage to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant select, insert, delete on storage.objects to authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant execute on function storage.foldername(text) to anon, authenticated;
create publication supabase_realtime;
