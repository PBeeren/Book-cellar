-- =====================================================================
--  Cellar Book — database schema for Supabase
--  Run this once in Supabase → SQL Editor → New query → Run.
--  Multi-cellar ready: every row belongs to one cellar, and access rules
--  (Row Level Security) make sure people only ever see their own cellar.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- tables ---------------------------------------------------

create table if not exists public.cellars (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 120),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  settings   jsonb not null default '{}'::jsonb,  -- staff only: pricing rule, wine-list texts, order
  shop       jsonb not null default '{}'::jsonb,  -- webshop: enabled, name, intro, email, phone, note, showQty, factor, round
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  cellar_id  uuid not null references public.cellars on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  role       text not null check (role in ('owner','manager','employee')),
  email      text not null default '',
  created_at timestamptz not null default now(),
  primary key (cellar_id, user_id)
);
create index if not exists members_user_idx on public.members(user_id);

create table if not exists public.invites (
  cellar_id  uuid not null references public.cellars on delete cascade,
  email      text not null check (email = lower(email) and position('@' in email) > 1),
  role       text not null check (role in ('manager','employee')),
  created_at timestamptz not null default now(),
  primary key (cellar_id, email)
);

create table if not exists public.wines (
  cellar_id   uuid not null references public.cellars on delete cascade,
  code        text not null check (code ~ '^[A-Za-z0-9_-]{1,64}$'),
  name        text not null default '' check (length(name) <= 300),
  vintage     text not null default '',
  type        text not null default '',
  country     text not null default '',
  region      text not null default '',
  sub         text not null default '',
  cls         text not null default '',
  price       numeric(10,2) not null default 0 check (price >= 0),        -- cost price
  sell        numeric(10,2) not null default 0 check (sell >= 0),         -- menu price
  sell_manual boolean not null default false,
  shop_price  numeric(10,2) not null default 0 check (shop_price >= 0),   -- fixed webshop price (0 = automatic)
  no_shop     boolean not null default false,
  bottles     integer not null default 0 check (bottles >= 0),
  loc         text not null default '',
  aliases     text[] not null default '{}',
  photo       text not null default '',   -- path in the "photos" storage bucket
  list_name   text not null default '',
  descr       text not null default '' check (length(descr) <= 4000),
  updated_at  timestamptz not null default now(),
  primary key (cellar_id, code)
);
create index if not exists wines_aliases_idx on public.wines using gin (aliases);

create table if not exists public.movements (
  id        bigint generated always as identity primary key,
  cellar_id uuid not null references public.cellars on delete cascade,
  ts        timestamptz not null default now(),
  code      text not null,
  name      text not null default '',
  kind      text not null check (kind in ('in','out','adj','order','cancel')),
  delta     integer not null,
  place     text not null default '',
  by        uuid,
  order_id  bigint
);
create index if not exists movements_cellar_ts_idx on public.movements(cellar_id, ts desc);

create table if not exists public.orders (
  id         bigint generated always as identity primary key,
  cellar_id  uuid not null references public.cellars on delete cascade,
  created_at timestamptz not null default now(),
  status     text not null default 'new' check (status in ('new','confirmed','ready','done','cancelled')),
  customer   jsonb not null,
  items      jsonb not null,
  total      numeric(10,2) not null default 0,
  staff_note text not null default ''
);
create index if not exists orders_cellar_idx on public.orders(cellar_id, created_at desc);

-- ---------- helper functions -----------------------------------------

create or replace function public.my_role(c uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where cellar_id = c and user_id = auth.uid()
$$;

create or replace function public.is_member(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where cellar_id = c and user_id = auth.uid())
$$;

create or replace function public.is_manager(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where cellar_id = c and user_id = auth.uid() and role in ('owner','manager'))
$$;

-- webshop price: fixed shop price, else cost price × factor rounded up to the step
create or replace function public.shop_price_of(p_shop_price numeric, p_cost numeric, p_shop jsonb) returns numeric
language sql immutable as $$
  select case
    when p_shop_price > 0 then p_shop_price
    when p_cost > 0 then
      case when coalesce(nullif(p_shop->>'round','')::numeric, 1) > 0
        then ceil(round(p_cost * coalesce(nullif(p_shop->>'factor','')::numeric, 1.8)
                  / coalesce(nullif(p_shop->>'round','')::numeric, 1), 6))
             * coalesce(nullif(p_shop->>'round','')::numeric, 1)
        else round(p_cost * coalesce(nullif(p_shop->>'factor','')::numeric, 1.8), 2)
      end
    else 0 end
$$;

-- ---------- guards ---------------------------------------------------
-- Stock only changes through the functions below (they set cellar.rpc),
-- or by a manager. Employees can never change prices or stock directly.

create or replace function public.wines_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if coalesce(current_setting('cellar.rpc', true), '') = '1' then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    new.cellar_id := old.cellar_id;
    if not public.is_manager(new.cellar_id) then
      new.code := old.code;
      new.price := old.price; new.sell := old.sell; new.sell_manual := old.sell_manual;
      new.shop_price := old.shop_price; new.no_shop := old.no_shop; new.bottles := old.bottles;
    end if;
  else
    if not public.is_manager(new.cellar_id) then
      new.price := 0; new.sell := 0; new.sell_manual := false; new.shop_price := 0; new.no_shop := false; new.bottles := 0;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists wines_guard on public.wines;
create trigger wines_guard before insert or update on public.wines
  for each row execute function public.wines_guard();

-- ---------- row level security ---------------------------------------

alter table public.cellars   enable row level security;
alter table public.members   enable row level security;
alter table public.invites   enable row level security;
alter table public.wines     enable row level security;
alter table public.movements enable row level security;
alter table public.orders    enable row level security;

drop policy if exists cellars_read on public.cellars;
create policy cellars_read on public.cellars for select to authenticated using (public.is_member(id));
drop policy if exists cellars_update on public.cellars;
create policy cellars_update on public.cellars for update to authenticated
  using (public.is_manager(id)) with check (public.is_manager(id));

drop policy if exists members_read on public.members;
create policy members_read on public.members for select to authenticated using (public.is_member(cellar_id));

drop policy if exists invites_all on public.invites;
create policy invites_all on public.invites for all to authenticated
  using (public.is_manager(cellar_id)) with check (public.is_manager(cellar_id));

drop policy if exists wines_read on public.wines;
create policy wines_read on public.wines for select to authenticated using (public.is_member(cellar_id));
drop policy if exists wines_insert on public.wines;
create policy wines_insert on public.wines for insert to authenticated with check (public.is_member(cellar_id));
drop policy if exists wines_update on public.wines;
create policy wines_update on public.wines for update to authenticated
  using (public.is_member(cellar_id)) with check (public.is_member(cellar_id));
drop policy if exists wines_delete on public.wines;
create policy wines_delete on public.wines for delete to authenticated using (public.is_manager(cellar_id));

drop policy if exists movements_read on public.movements;
create policy movements_read on public.movements for select to authenticated using (public.is_member(cellar_id));

drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated using (public.is_member(cellar_id));

-- ---------- functions the app calls ----------------------------------

-- Create a new cellar; the caller becomes its owner.
create or replace function public.create_cellar(p_name text, p_slug text) returns uuid
language plpgsql security definer set search_path = public as $$
declare c uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  insert into public.cellars(name, slug, shop) values (trim(p_name), lower(trim(p_slug)),
    jsonb_build_object('enabled', false, 'name', trim(p_name), 'factor', 1.8, 'round', 1))
    returning id into c;
  insert into public.members(cellar_id, user_id, role, email)
    values (c, auth.uid(), 'owner', coalesce(lower(auth.jwt()->>'email'), ''));
  return c;
end $$;

-- Join every cellar this e-mail address was invited to.
create or replace function public.accept_invites() returns integer
language plpgsql security definer set search_path = public as $$
declare e text := lower(coalesce(auth.jwt()->>'email', '')); n integer;
begin
  if auth.uid() is null or e = '' then return 0; end if;
  insert into public.members(cellar_id, user_id, role, email)
    select cellar_id, auth.uid(), role, e from public.invites where email = e
    on conflict (cellar_id, user_id) do nothing;
  get diagnostics n = row_count;
  delete from public.invites where email = e;
  return n;
end $$;

create or replace function public.remove_member(c uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager(c) then raise exception 'Managers only'; end if;
  if exists (select 1 from public.members where cellar_id = c and user_id = p_user and role = 'owner') then
    raise exception 'The owner cannot be removed';
  end if;
  delete from public.members where cellar_id = c and user_id = p_user;
end $$;

create or replace function public.set_member_role(c uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager(c) then raise exception 'Managers only'; end if;
  if p_role not in ('manager','employee') then raise exception 'Unknown role'; end if;
  update public.members set role = p_role where cellar_id = c and user_id = p_user and role <> 'owner';
end $$;

-- Scan in / out and manual stock corrections. Returns the new bottle count.
create or replace function public.adjust_stock(c uuid, p_code text, p_delta integer, p_kind text, p_place text default '')
returns integer
language plpgsql security definer set search_path = public as $$
declare r text := public.my_role(c); n integer; nm text; pl text := upper(trim(coalesce(p_place, '')));
begin
  if r is null then raise exception 'You are not a member of this cellar'; end if;
  if p_kind not in ('in','out','adj') then raise exception 'Unknown movement'; end if;
  if p_kind = 'adj' and r not in ('owner','manager') then raise exception 'Only managers can correct stock'; end if;
  if p_kind = 'in'  and (p_delta < 1 or p_delta > 999) then raise exception 'Invalid quantity'; end if;
  if p_kind = 'out' and (p_delta > -1 or p_delta < -999) then raise exception 'Invalid quantity'; end if;
  if p_delta = 0 then raise exception 'Nothing to change'; end if;
  perform set_config('cellar.rpc', '1', true);
  update public.wines w set
      bottles = w.bottles + p_delta,
      loc = case
        when pl = '' or pl = any (select upper(trim(x)) from unnest(string_to_array(w.loc, ',')) x) then w.loc
        when trim(w.loc) = '' then pl
        else w.loc || ', ' || pl end
    where w.cellar_id = c and w.code = p_code and w.bottles + p_delta >= 0
    returning w.bottles, w.name into n, nm;
  if not found then
    perform set_config('cellar.rpc', '0', true);
    if exists (select 1 from public.wines where cellar_id = c and code = p_code) then
      raise exception 'Not enough bottles in stock';
    end if;
    raise exception 'Unknown wine';
  end if;
  insert into public.movements(cellar_id, code, name, kind, delta, place, by)
    values (c, p_code, nm, p_kind, p_delta, pl, auth.uid());
  perform set_config('cellar.rpc', '0', true);
  return n;
end $$;

-- Record stock that a manager set directly (import, editor): log only.
create or replace function public.log_adjustments(c uuid, p_rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager(c) then raise exception 'Managers only'; end if;
  insert into public.movements(cellar_id, code, name, kind, delta, by)
    select c, x->>'code', coalesce(x->>'name',''), 'adj', (x->>'delta')::int, auth.uid()
    from jsonb_array_elements(p_rows) x where coalesce((x->>'delta')::int, 0) <> 0;
end $$;

-- Merge duplicate wines into p_keep. Bottles, places and barcodes are combined.
create or replace function public.merge_wines(c uuid, p_keep text, p_others text[]) returns void
language plpgsql security definer set search_path = public as $$
declare k public.wines; o public.wines; pl text;
begin
  if not public.is_manager(c) then raise exception 'Managers only'; end if;
  select * into k from public.wines where cellar_id = c and code = p_keep for update;
  if not found then raise exception 'Unknown wine %', p_keep; end if;
  for o in select * from public.wines where cellar_id = c and code = any (p_others) and code <> p_keep for update loop
    k.bottles := k.bottles + o.bottles;
    foreach pl in array string_to_array(o.loc, ',') loop
      pl := upper(trim(pl));
      if pl <> '' and not (pl = any (select upper(trim(x)) from unnest(string_to_array(k.loc, ',')) x)) then
        k.loc := case when trim(k.loc) = '' then pl else k.loc || ', ' || pl end;
      end if;
    end loop;
    if k.country = '' then k.country := o.country; end if;
    if k.region = '' then k.region := o.region; end if;
    if k.sub = '' then k.sub := o.sub; end if;
    if k.cls = '' then k.cls := o.cls; end if;
    if k.type = '' then k.type := o.type; end if;
    if k.price = 0 then k.price := o.price; end if;
    if k.sell = 0 then k.sell := o.sell; k.sell_manual := o.sell_manual; end if;
    if k.shop_price = 0 then k.shop_price := o.shop_price; end if;
    if k.photo = '' then k.photo := o.photo; end if;
    if k.descr = '' then k.descr := o.descr; end if;
    k.aliases := array(select distinct a from unnest(k.aliases || o.aliases || array[o.code]) a where a <> p_keep);
    delete from public.wines where cellar_id = c and code = o.code;
  end loop;
  perform set_config('cellar.rpc', '1', true);
  update public.wines set bottles = k.bottles, loc = k.loc, country = k.country, region = k.region, sub = k.sub,
    cls = k.cls, type = k.type, price = k.price, sell = k.sell, sell_manual = k.sell_manual, shop_price = k.shop_price,
    photo = k.photo, descr = k.descr, aliases = k.aliases
    where cellar_id = c and code = p_keep;
  perform set_config('cellar.rpc', '0', true);
end $$;

-- ---------- webshop (callable without an account) --------------------

create or replace function public.get_shop(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'shop', jsonb_build_object(
      'name', coalesce(nullif(c.shop->>'name',''), c.name),
      'intro', coalesce(c.shop->>'intro',''), 'email', coalesce(c.shop->>'email',''),
      'phone', coalesce(c.shop->>'phone',''), 'note', coalesce(c.shop->>'note',''),
      'showQty', coalesce((c.shop->>'showQty')::boolean, false)),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'c', w.code, 'n', coalesce(nullif(w.list_name,''), w.name), 'v', w.vintage, 't', w.type,
        'co', w.country, 'r', w.region, 's', w.sub, 'cl', w.cls, 'd', w.descr, 'ph', w.photo,
        'q', w.bottles, 'p', public.shop_price_of(w.shop_price, w.price, c.shop)) order by w.name)
      from public.wines w where w.cellar_id = c.id and w.bottles > 0 and not w.no_shop and w.name <> ''), '[]'::jsonb))
  from public.cellars c
  where c.slug = lower(p_slug) and coalesce((c.shop->>'enabled')::boolean, false)
$$;

-- Place an order. Stock is reserved (taken off) immediately; cancelling puts it back.
create or replace function public.place_order(p_slug text, p_items jsonb, p_customer jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cel public.cellars; it jsonb; w public.wines; q integer; pr numeric; total numeric := 0;
  lines jsonb := '[]'::jsonb; oid bigint; cust jsonb; nb integer := 0;
begin
  select * into cel from public.cellars where slug = lower(p_slug) and coalesce((shop->>'enabled')::boolean, false);
  if not found then raise exception 'Deze webshop bestaat niet of is gesloten'; end if;
  cust := jsonb_build_object(
    'name',  left(trim(coalesce(p_customer->>'name','')), 120),
    'email', left(trim(coalesce(p_customer->>'email','')), 200),
    'phone', left(trim(coalesce(p_customer->>'phone','')), 40),
    'how',   case when p_customer->>'how' = 'Bezorgen' then 'Bezorgen' else 'Afhalen' end,
    'note',  left(trim(coalesce(p_customer->>'note','')), 1000));
  if cust->>'name' = '' then raise exception 'Vul je naam in'; end if;
  if cust->>'email' = '' and cust->>'phone' = '' then raise exception 'Vul een e-mailadres of telefoonnummer in'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Je winkelmand is leeg'; end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'Te veel verschillende wijnen in één bestelling'; end if;

  perform set_config('cellar.rpc', '1', true);
  for it in select * from jsonb_array_elements(p_items) loop
    q := coalesce((it->>'qty')::int, 0);
    if q < 1 or q > 48 then raise exception 'Ongeldig aantal'; end if;
    select * into w from public.wines where cellar_id = cel.id and code = it->>'code' and not no_shop for update;
    if not found then raise exception 'Een wijn in je mand is niet meer beschikbaar'; end if;
    if w.bottles < q then
      raise exception 'Nog maar % fles(sen) van % beschikbaar', w.bottles, coalesce(nullif(w.list_name,''), w.name);
    end if;
    nb := nb + q;
    pr := public.shop_price_of(w.shop_price, w.price, cel.shop);
    total := total + pr * q;
    lines := lines || jsonb_build_object('code', w.code, 'name', coalesce(nullif(w.list_name,''), w.name),
                                         'vintage', w.vintage, 'qty', q, 'price', pr);
    update public.wines set bottles = bottles - q where cellar_id = cel.id and code = w.code;
  end loop;
  if nb > 120 then raise exception 'Bestel maximaal 120 flessen per keer; neem contact op voor grotere bestellingen'; end if;
  insert into public.orders(cellar_id, customer, items, total) values (cel.id, cust, lines, total) returning id into oid;
  insert into public.movements(cellar_id, code, name, kind, delta, order_id)
    select cel.id, x->>'code', x->>'name', 'order', -((x->>'qty')::int), oid from jsonb_array_elements(lines) x;
  perform set_config('cellar.rpc', '0', true);
  return jsonb_build_object('id', oid, 'total', total, 'items', lines);
end $$;

-- Change an order's status (staff). Cancelling returns the bottles to stock.
create or replace function public.set_order_status(p_order bigint, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare o public.orders; x jsonb;
begin
  select * into o from public.orders where id = p_order for update;
  if not found or not public.is_member(o.cellar_id) then raise exception 'Unknown order'; end if;
  if p_status not in ('new','confirmed','ready','done','cancelled') then raise exception 'Unknown status'; end if;
  if o.status = 'cancelled' and p_status <> 'cancelled' then raise exception 'A cancelled order cannot be reopened'; end if;
  if p_status = 'cancelled' and o.status <> 'cancelled' then
    perform set_config('cellar.rpc', '1', true);
    for x in select * from jsonb_array_elements(o.items) loop
      update public.wines set bottles = bottles + (x->>'qty')::int where cellar_id = o.cellar_id and code = x->>'code';
      if found then
        insert into public.movements(cellar_id, code, name, kind, delta, by, order_id)
          values (o.cellar_id, x->>'code', x->>'name', 'cancel', (x->>'qty')::int, auth.uid(), o.id);
      end if;
    end loop;
    perform set_config('cellar.rpc', '0', true);
  end if;
  update public.orders set status = p_status, staff_note = coalesce(p_note, staff_note) where id = p_order;
end $$;

-- ---------- permissions ---------------------------------------------

revoke all on all functions in schema public from public, anon;
grant execute on function public.get_shop(text), public.place_order(text, jsonb, jsonb) to anon, authenticated;
grant execute on function
  public.my_role(uuid), public.is_member(uuid), public.is_manager(uuid),
  public.shop_price_of(numeric, numeric, jsonb),
  public.create_cellar(text, text), public.accept_invites(), public.remove_member(uuid, uuid),
  public.set_member_role(uuid, uuid, text), public.adjust_stock(uuid, text, integer, text, text),
  public.log_adjustments(uuid, jsonb), public.merge_wines(uuid, text, text[]),
  public.set_order_status(bigint, text, text)
  to authenticated;
revoke all on public.cellars, public.members, public.invites, public.wines, public.movements, public.orders from anon;
grant select, update on public.cellars to authenticated;
grant select on public.members, public.movements, public.orders to authenticated;
grant select, insert, update, delete on public.invites, public.wines to authenticated;

-- ---------- live updates (Supabase Realtime) -------------------------

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.wines;     exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.movements; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.orders;    exception when duplicate_object then null; end;
  end if;
end $$;

-- ---------- wine photos (Supabase Storage) ---------------------------
-- Public bucket "photos"; files live under <cellar id>/... and only that
-- cellar's members may add or remove them.

insert into storage.buckets (id, name, public) values ('photos', 'photos', true)
  on conflict (id) do nothing;

drop policy if exists "cellar photos insert" on storage.objects;
create policy "cellar photos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
drop policy if exists "cellar photos delete" on storage.objects;
create policy "cellar photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_member(((storage.foldername(name))[1])::uuid));
