\set ON_ERROR_STOP 1
insert into colleges (id, name, payer, upi_id) values ('col-a', 'College A', 'students', 'a@bank'), ('col-b', 'College B', 'college', null);
insert into colleges (id, name, active) values ('col-off', 'Hidden', false);
insert into staff (email, role, college_id) values ('admin@rtih.test', 'admin', null), ('coord@a.test', 'coordinator', 'col-a');
insert into students (college_id, name, student_id, email, phone, year, branch, coding, data, ui, writing, presenting, github_comfort, consent_data, status)
select c, 'Student ' || i, 'S' || i, 's' || i || '@x.test', '9' || lpad(i::text, 9, '0'), '2nd year', 'CSE', 1 + i % 3, 2, 2, 2, 2, 2, true,
  case when i % 5 = 0 then 'registered' else 'confirmed' end
from generate_series(1, 12) i, lateral (select case when i <= 8 then 'col-a' else 'col-b' end c) x;
insert into storage.objects (bucket_id, name) values ('payment-proofs', 'col-a/AB-00001.png'), ('payment-proofs', 'col-b/AB-00009.png');

-- 1. public key: colleges yes (active only), students no
set role anon;
select 'anon colleges' t, count(*) from colleges;
do $$ begin perform count(*) from students; raise exception 'anon could read students'; exception when insufficient_privilege then raise notice 'anon blocked from students: ok'; end $$;
do $$ begin insert into colleges(id, name) values ('evil', 'x'); raise exception 'anon could write colleges'; exception when insufficient_privilege then raise notice 'anon blocked from writing: ok'; end $$;
reset role;

-- 2. coordinator of college A sees only college A
set role authenticated; set request.jwt.claims = '{"email":"coord@a.test"}';
select 'coord students' t, count(*), string_agg(distinct college_id, ',') from students;
select 'coord proofs' t, count(*) from storage.objects;
do $$ begin perform pay_token from students limit 1; raise exception 'pay_token readable'; exception when insufficient_privilege then raise notice 'pay_token hidden: ok'; end $$;
do $$ begin update students set status = 'confirmed'; raise exception 'coord could update'; exception when insufficient_privilege then raise notice 'coord cannot write: ok'; end $$;
do $$ begin perform public.app_get_team_key(gen_random_uuid()); raise exception 'coord could read keys'; exception when insufficient_privilege then raise notice 'key function blocked: ok'; end $$;
select 'coord audit' t, count(*) from audit_log;

-- 3. admin sees everything; a stranger sees nothing
set request.jwt.claims = '{"email":"admin@rtih.test"}';
select 'admin students' t, count(*) from students;
select 'admin colleges incl hidden' t, count(*) from colleges;
set request.jwt.claims = '{"email":"stranger@x.test"}';
select 'stranger students' t, count(*) from students;
reset role;

-- 4. team save + keys as the server
set role service_role;
select 'save teams' t, app_save_teams('col-a', (
  select jsonb_build_array(
    jsonb_build_object('number', 1, 'name', 'Team Godavari', 'members', jsonb_agg(jsonb_build_object('student', id, 'role', 'Data'))))
  from (select id from students where college_id = 'col-a' and status = 'confirmed' limit 4) s));
select 'members' t, count(*) from students where team_id is not null;
-- unconfirmed member must be refused
do $$ begin perform app_save_teams('col-a', jsonb_build_array(jsonb_build_object('number', 1, 'name', 'Team X',
  'members', jsonb_build_array(jsonb_build_object('student', (select id from students where status = 'registered' and college_id = 'col-a' limit 1), 'role', 'Data')))));
  raise exception 'unconfirmed accepted'; exception when raise_exception then raise notice 'unconfirmed refused: ok'; end $$;
select app_store_team_key((select id from teams limit 1), 'sk-proj-abcdefghijklmnopqrstuvwxyz1234');
select 'key last4' t, key_last4, app_get_team_key(id) = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234' as roundtrip from teams;
select app_store_team_key((select id from teams limit 1), 'sk-proj-zzzzzzzzzzzzzzzzzzzzzzzzzz9999');
select 'key rotated' t, key_last4 from teams;
select 'deleted keys' t, app_delete_team_keys('col-a');
reset role;
select 'vault secrets after delete' t, count(*) from vault.secrets;
-- duplicate payment reference blocked
update students set payment_mode = 'UPI', payment_ref = '123456' where reference = 'AB-00001';
do $$ begin update students set payment_mode = 'UPI', payment_ref = '123456' where reference = 'AB-00002'; raise exception 'dup ref allowed'; exception when unique_violation then raise notice 'duplicate UTR blocked: ok'; end $$;
