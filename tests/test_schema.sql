\set ON_ERROR_STOP 1
\set QUIET 1
-- helpers (test only)
create or replace function public.t_ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAIL: %', msg; end if; raise notice 'ok  %', msg; end $$;
create or replace function public.t_err(stmt text, pat text, msg text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if sqlerrm ilike '%'||pat||'%' then raise notice 'ok  % (%)', msg, sqlerrm; return; end if;
    raise exception 'FAIL: % — wrong error: %', msg, sqlerrm;
  end;
  raise exception 'FAIL: % — no error', msg;
end $$;
grant execute on function public.t_ok(boolean,text), public.t_err(text,text,text) to anon, authenticated;
insert into auth.users values
 ('11111111-1111-1111-1111-111111111111','owner@a.nl'),
 ('22222222-2222-2222-2222-222222222222','staff@a.nl'),
 ('33333333-3333-3333-3333-333333333333','owner@b.nl'),
 ('44444444-4444-4444-4444-444444444444','stranger@x.nl');

-- ===== owner A creates a cellar =====
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false), set_config('request.jwt.claim.email','owner@a.nl',false);
set role authenticated;
select set_config('t.a', public.create_cellar('Kelder A','kelder-a')::text, false);
select t_ok((select count(*) from cellars)=1, 'owner sees own cellar');
select t_ok(my_role(current_setting('t.a')::uuid)='owner', 'creator is owner');
insert into wines(cellar_id,code,name,vintage,price,bottles,type) values
 (current_setting('t.a')::uuid,'W1','Barolo','2018',25,3,'Rood'),
 (current_setting('t.a')::uuid,'W2','Chablis','2021',12.40,1,'Wit'),
 (current_setting('t.a')::uuid,'W3','Chablis','2021',0,2,'Wit'),
 (current_setting('t.a')::uuid,'W4','Secret','2020',10,5,'Rood');
update wines set no_shop=true where code='W4';
select t_ok((select bottles from wines where code='W1')=3, 'manager may set bottles directly');
select t_ok(adjust_stock(current_setting('t.a')::uuid,'W1',1,'in','a12')=4, 'scan in +1');
select t_ok((select loc from wines where code='W1')='A12', 'place added uppercase');
select t_ok(adjust_stock(current_setting('t.a')::uuid,'W1',1,'in','A12')=5, 'scan in same place');
select t_ok((select loc from wines where code='W1')='A12', 'place not duplicated');
select t_ok(adjust_stock(current_setting('t.a')::uuid,'W2',-1,'out')=0, 'scan out to 0');
select t_err($$select adjust_stock(current_setting('t.a')::uuid,'W2',-1,'out')$$,'Not enough','cannot go below 0');
select t_err($$select adjust_stock(current_setting('t.a')::uuid,'ZZ',1,'in')$$,'Unknown wine','unknown code');
select t_ok((select count(*) from movements)=3, 'movements logged');
insert into invites(cellar_id,email,role) values (current_setting('t.a')::uuid,'staff@a.nl','employee');
update cellars set shop = shop || '{"enabled":true,"factor":2,"round":1,"email":"x@a.nl"}' where id=current_setting('t.a')::uuid;
reset role;

-- ===== employee joins and is limited =====
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false), set_config('request.jwt.claim.email','STAFF@a.nl',false);
set role authenticated;
select t_ok((select count(*) from wines)=0, 'not a member yet: sees nothing');
select t_ok(accept_invites()=1, 'invite accepted (email case-insensitive)');
select t_ok(my_role(current_setting('t.a')::uuid)='employee', 'role employee');
select t_ok((select count(*) from wines)=4, 'employee sees wines');
update wines set price=1, bottles=99, name='Barolo Cannubi' where code='W1';
select t_ok((select price from wines where code='W1')=25 and (select bottles from wines where code='W1')=5 and (select name from wines where code='W1')='Barolo Cannubi', 'employee: name changes, price/stock protected');
select t_ok(adjust_stock(current_setting('t.a')::uuid,'W1',-1,'out')=4, 'employee can scan out');
select t_err($$select adjust_stock(current_setting('t.a')::uuid,'W1',5,'adj')$$,'Only managers','employee cannot adj');
insert into wines(cellar_id,code,name,price,bottles) values (current_setting('t.a')::uuid,'NEW1','New wine',50,10);
select t_ok((select bottles from wines where code='NEW1')=0 and (select price from wines where code='NEW1')=0, 'employee insert: stock/price zeroed');
select t_ok(adjust_stock(current_setting('t.a')::uuid,'NEW1',2,'in')=2, 'then scan in 2');
delete from wines where code='W1';
select t_ok((select count(*) from wines where code='W1')=1, 'employee cannot delete');
update cellars set name='Hacked' where id=current_setting('t.a')::uuid;
select t_ok((select name from cellars)='Kelder A', 'employee cannot change cellar');
select t_err($$insert into invites values (current_setting('t.a')::uuid,'x@y.nl','manager')$$,'row-level security','employee cannot invite');
select t_err($$select merge_wines(current_setting('t.a')::uuid,'W2',array['W3'])$$,'Managers only','employee cannot merge');
reset role;

-- ===== other cellar owner and stranger see nothing =====
select set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false), set_config('request.jwt.claim.email','owner@b.nl',false);
set role authenticated;
select set_config('t.b', public.create_cellar('Kelder B','kelder-b')::text, false);
select t_ok((select count(*) from cellars)=1, 'B sees only own cellar');
select t_ok((select count(*) from wines)=0, 'B sees no wines of A');
select t_ok((select count(*) from movements)=0 and (select count(*) from orders)=0 and (select count(*) from members)=1, 'B sees no movements/orders/members of A');
update wines set bottles=0 where cellar_id=current_setting('t.a')::uuid;
select t_err($$select adjust_stock(current_setting('t.a')::uuid,'W1',-1,'out')$$,'not a member','B cannot scan in A');
select t_err($$insert into wines(cellar_id,code,name) values (current_setting('t.a')::uuid,'X','x')$$,'row-level security','B cannot insert into A');
select t_err($$select create_cellar('Dup','kelder-a')$$,'duplicate','slug unique');
select t_err($$insert into storage.objects(bucket_id,name) values ('photos', current_setting('t.a')||'/x.jpg')$$,'row-level security','B cannot upload into A folder');
insert into storage.objects(bucket_id,name) values ('photos', current_setting('t.b')||'/x.jpg');
select t_ok(true,'B can upload into own folder');
reset role;

-- ===== anonymous webshop =====
select set_config('request.jwt.claim.sub','',false), set_config('request.jwt.claim.email','',false);
set role anon;
select t_err($$select count(*) from wines$$,'permission denied','anon cannot read wines table');
select t_ok(get_shop('kelder-b') is null, 'closed shop returns nothing');
select t_ok(jsonb_array_length(get_shop('kelder-a')->'items')=3, 'shop: only in stock, not hidden (W1,W3,NEW1)');
select t_ok((select (x->>'p')::numeric from jsonb_array_elements(get_shop('kelder-a')->'items') x where x->>'c'='W1')=50, 'shop price 25×2=50');
select t_ok((select (x->>'p')::numeric from jsonb_array_elements(get_shop('kelder-a')->'items') x where x->>'c'='W3')=0, 'no cost price → 0 (op aanvraag)');
select t_ok(not (get_shop('kelder-a')::text ilike '%"price"%') and not (get_shop('kelder-a')::text ilike '%A12%'), 'shop leaks no cost price / places');
select t_err($$select place_order('kelder-a','[{"code":"W1","qty":10}]','{"name":"Jan","email":"j@x.nl"}')$$,'Nog maar','cannot order more than stock');
select t_err($$select place_order('kelder-a','[{"code":"W4","qty":1}]','{"name":"Jan","email":"j@x.nl"}')$$,'niet meer beschikbaar','hidden wine not orderable');
select t_err($$select place_order('kelder-a','[{"code":"W1","qty":1}]','{"name":"","email":"j@x.nl"}')$$,'naam','name required');
select t_err($$select place_order('kelder-a','[{"code":"W1","qty":1}]','{"name":"Jan"}')$$,'e-mailadres','contact required');
select t_err($$select place_order('kelder-b','[{"code":"W1","qty":1}]','{"name":"Jan","email":"j@x.nl"}')$$,'gesloten','closed shop rejects');
select set_config('t.o', (place_order('kelder-a','[{"code":"W1","qty":2},{"code":"NEW1","qty":1}]','{"name":"Jan","email":"j@x.nl","how":"Afhalen"}')->>'id'), false);
select t_err($$select set_order_status(1,'cancelled')$$,'permission denied','anon cannot change orders');
reset role;
select t_ok((select bottles from wines where code='W1')=2, 'order reserved stock (4-2)');
select t_ok((select total from orders where id=current_setting('t.o')::bigint)=100, 'order total uses server price, NEW1 price 0');

-- ===== staff handles the order =====
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',false);
set role authenticated;
select t_ok((select count(*) from orders)=1, 'employee sees order');
select set_order_status(current_setting('t.o')::bigint,'ready');
select set_order_status(current_setting('t.o')::bigint,'cancelled');
select t_ok((select bottles from wines where code='W1')=4 and (select bottles from wines where code='NEW1')=2, 'cancel returns stock');
select set_order_status(current_setting('t.o')::bigint,'cancelled');
select t_ok((select bottles from wines where code='W1')=4, 'cancel twice does not double');
select t_err($$select set_order_status(current_setting('t.o')::bigint,'new')$$,'cannot be reopened','no reopen');
reset role;
select set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333',false);
set role authenticated;
select t_err($$select set_order_status(current_setting('t.o')::bigint,'done')$$,'Unknown order','B cannot touch A order');
reset role;

-- ===== owner merges duplicates, manages team =====
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
set role authenticated;
update wines set loc='B1' where code='W3';
select merge_wines(current_setting('t.a')::uuid,'W2',array['W3']);
select t_ok((select bottles from wines where code='W2')=2 and (select aliases from wines where code='W2')=array['W3'] and (select price from wines where code='W2')=12.40 and (select loc from wines where code='W2')='B1', 'merge combined');
select t_ok((select count(*) from wines where code='W3')=0, 'merged duplicate removed');
select log_adjustments(current_setting('t.a')::uuid,'[{"code":"W2","name":"Chablis","delta":3}]');
select t_ok((select count(*) from movements where kind='adj')=1, 'log adjustments');
select t_ok((select count(*) from members)=2, 'owner sees team');
select set_member_role(current_setting('t.a')::uuid,'22222222-2222-2222-2222-222222222222','manager');
select t_err($$select remove_member(current_setting('t.a')::uuid,'11111111-1111-1111-1111-111111111111')$$,'owner cannot','owner protected');
select remove_member(current_setting('t.a')::uuid,'22222222-2222-2222-2222-222222222222');
select t_ok((select count(*) from members)=1, 'member removed');
select t_ok(shop_price_of(0, 12.40, '{"factor":1.8,"round":0.5}')=22.50, 'rounding 12.40×1.8=22.32→22.50');
select t_ok(shop_price_of(0, 10, '{"factor":1.8,"round":1}')=18, 'exact 18 stays 18');
select t_ok(shop_price_of(0, 10, '{"factor":1.75,"round":0}')=17.50, 'no rounding');
reset role;
\echo ALL-TESTS-PASSED
