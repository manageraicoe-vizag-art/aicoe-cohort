-- AI Builders Cohort: database, access rules and key storage.
-- Run once on a new Supabase project (SQL editor, or `supabase db push`).
--
-- Rules of thumb:
--   * The website talks to the database with the public (anon) key, so every table has row level security.
--   * Students never read or write tables directly: the `register` and `payment` functions do it for them.
--   * Staff (RTIH admins and college coordinators) can READ what their role allows; every change goes
--     through the `staff` function, which checks the role again and writes the audit log.
--   * OpenAI keys live in Supabase Vault, encrypted, and only the server functions can read them.

-- ---------------------------------------------------------------- settings
create table public.settings (
  id int primary key default 1 check (id = 1),
  programme text not null default 'AI Builders Cohort',
  fee_inr int not null default 250 check (fee_inr >= 0),
  registration_open boolean not null default true,
  deadline date,
  contact text not null default 'head.aicoe-vizag@rtih.co.in',
  session_info text not null default 'Sundays, 11:00 am to 12:00 pm IST (optional, recorded)',
  session_link text,
  guide_link text,
  site_url text,                       -- e.g. https://cohort.rtih.co.in (used in email links)
  retention_days int not null default 90,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

-- ---------------------------------------------------------------- colleges
create table public.colleges (
  id text primary key check (id ~ '^[a-z0-9-]{2,30}$'),
  name text not null,
  payer text not null default 'students' check (payer in ('students', 'college')),
  payee_name text,
  upi_id text,
  qr_image_url text,
  bank_account_name text,
  bank_name text,
  bank_account_number text,
  bank_ifsc text,
  cash_at text,                         -- where students pay cash; null = no cash
  seat_limit int check (seat_limit is null or seat_limit > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- staff
create table public.staff (
  email text primary key check (email = lower(email)),
  name text,
  role text not null check (role in ('admin', 'coordinator')),
  college_id text references public.colleges (id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((role = 'admin' and college_id is null) or (role = 'coordinator' and college_id is not null))
);

-- ---------------------------------------------------------------- teams
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  college_id text not null references public.colleges (id),
  number int not null check (number > 0),
  name text not null unique,
  status text not null default 'draft' check (status in ('draft', 'published')),
  key_secret_id uuid,
  key_last4 text,
  key_sent_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (college_id, number)
);

-- ---------------------------------------------------------------- students
create sequence public.student_ref_seq start 1;

create table public.students (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default ('AB-' || lpad(nextval('public.student_ref_seq')::text, 5, '0')),
  college_id text not null references public.colleges (id),
  name text not null check (length(name) between 2 and 80),
  student_id text not null check (length(student_id) between 1 and 30),
  email text not null check (email = lower(email)),
  phone text not null check (phone ~ '^[6-9][0-9]{9}$'),
  year text not null,
  branch text not null,
  github text check (github is null or github ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'),
  coding smallint not null check (coding between 1 and 3),
  data smallint not null check (data between 1 and 3),
  ui smallint not null check (ui between 1 and 3),
  writing smallint not null check (writing between 1 and 3),
  presenting smallint not null check (presenting between 1 and 3),
  github_comfort smallint not null check (github_comfort between 1 and 3),
  knows text,
  consent_share_phone boolean not null default false,
  consent_startups boolean not null default false,
  consent_data boolean not null check (consent_data),
  status text not null default 'registered'
    check (status in ('registered', 'payment_submitted', 'confirmed', 'rejected', 'withdrawn')),
  pay_token uuid not null unique default gen_random_uuid(),
  payment_mode text check (payment_mode in ('UPI', 'Bank transfer', 'Cash')),
  payment_ref text,
  payment_proof_path text,
  payment_submitted_at timestamptz,
  rejected_reason text,
  verified_by text,
  verified_at timestamptz,
  team_id uuid references public.teams (id) on delete set null,
  team_role text,
  reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index students_email_uq on public.students (email);
create unique index students_sid_uq on public.students (college_id, upper(student_id));
create unique index students_payref_uq on public.students (college_id, payment_mode, upper(payment_ref))
  where payment_ref is not null and payment_mode <> 'Cash' and status <> 'withdrawn';
create index students_college_status on public.students (college_id, status);

create function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger students_touch before update on public.students
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- logs
create table public.email_log (
  id bigserial primary key,
  student_id uuid references public.students (id) on delete set null,
  team_id uuid references public.teams (id) on delete set null,
  college_id text,
  kind text not null,
  to_email text not null,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  error text,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id bigserial primary key,
  actor text not null,
  action text not null,
  target text,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- who is asking
create function public.current_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where email = public.current_email() and role = 'admin')
$$;

create function public.staff_college() returns text
language sql stable security definer set search_path = public as $$
  select college_id from public.staff where email = public.current_email() and role = 'coordinator'
$$;

create function public.can_see_college(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (c is not null and c = public.staff_college())
$$;

-- is_admin() and friends stay callable by everyone: the public colleges policy uses is_admin(),
-- and they only reveal facts about the caller.

-- ---------------------------------------------------------------- row level security
alter table public.settings enable row level security;
alter table public.colleges enable row level security;
alter table public.staff enable row level security;
alter table public.teams enable row level security;
alter table public.students enable row level security;
alter table public.email_log enable row level security;
alter table public.audit_log enable row level security;

-- Public: settings and the payment details of active colleges (shown on the registration page).
create policy settings_read on public.settings for select to anon, authenticated using (true);
create policy colleges_read on public.colleges for select to anon, authenticated using (active or public.is_admin());

-- Staff: read what their role allows. No insert/update/delete policies: changes go through the staff function.
create policy staff_read on public.staff for select to authenticated
  using (public.is_admin() or email = public.current_email());
create policy students_read on public.students for select to authenticated
  using (public.can_see_college(college_id));
create policy teams_read on public.teams for select to authenticated
  using (public.can_see_college(college_id));
create policy email_log_read on public.email_log for select to authenticated
  using (public.can_see_college(college_id));
create policy audit_log_read on public.audit_log for select to authenticated using (public.is_admin());

-- The public key may never read students, even by mistake.
revoke all on public.students, public.teams, public.staff, public.email_log, public.audit_log from anon;
-- Staff read students column by column: pay_token (it lets a student finish payment) is left out.
revoke all on public.students from authenticated;
grant select (id, reference, college_id, name, student_id, email, phone, year, branch, github,
  coding, data, ui, writing, presenting, github_comfort, knows, consent_share_phone, consent_startups,
  consent_data, status, payment_mode, payment_ref, payment_proof_path, payment_submitted_at,
  rejected_reason, verified_by, verified_at, team_id, team_role, reminded_at, created_at, updated_at)
  on public.students to authenticated;
-- Staff only read; writes are the server functions' job.
revoke insert, update, delete, truncate on public.settings, public.colleges, public.staff, public.teams,
  public.email_log, public.audit_log from anon, authenticated;

-- ---------------------------------------------------------------- team keys (Vault)
create function public.app_store_team_key(p_team uuid, p_key text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid;
begin
  select key_secret_id into sid from public.teams where id = p_team;
  if not found then raise exception 'team not found'; end if;
  if sid is null then
    sid := vault.create_secret(p_key, 'team-key-' || p_team::text);
  else
    perform vault.update_secret(sid, p_key);
  end if;
  update public.teams set key_secret_id = sid, key_last4 = right(p_key, 4), key_sent_at = null where id = p_team;
end $$;

create function public.app_get_team_key(p_team uuid) returns text
language sql stable security definer set search_path = public, vault as $$
  select s.decrypted_secret from vault.decrypted_secrets s
  join public.teams t on t.key_secret_id = s.id where t.id = p_team
$$;

create function public.app_delete_team_keys(p_college text) returns int
language plpgsql security definer set search_path = public, vault as $$
declare n int;
begin
  delete from vault.secrets where id in (select key_secret_id from public.teams where college_id = p_college and key_secret_id is not null);
  get diagnostics n = row_count;
  update public.teams set key_secret_id = null, key_last4 = null where college_id = p_college;
  return n;
end $$;

-- ---------------------------------------------------------------- saving teams (atomic)
-- p_teams: [{"number":1,"name":"Team Godavari","members":[{"student":"<uuid>","role":"Data"}, ...]}, ...]
create function public.app_save_teams(p_college text, p_teams jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare t jsonb; m jsonb; tid uuid; n int := 0; bad int;
begin
  -- members must be confirmed students of this college, not already in a published team, and listed once
  select count(*) into bad from (
    select (m2 ->> 'student')::uuid as sid
    from jsonb_array_elements(p_teams) t2, jsonb_array_elements(t2 -> 'members') m2
  ) x left join public.students s on s.id = x.sid
    left join public.teams pt on pt.id = s.team_id and pt.status = 'published'
  where s.id is null or s.college_id <> p_college or s.status <> 'confirmed' or pt.id is not null;
  if bad > 0 then raise exception 'some members are not confirmed students of this college, or are already in a published team'; end if;
  if (select count(*) from jsonb_array_elements(p_teams) t2, jsonb_array_elements(t2 -> 'members') m2)
     <> (select count(distinct m2 ->> 'student') from jsonb_array_elements(p_teams) t2, jsonb_array_elements(t2 -> 'members') m2) then
    raise exception 'a student is listed in more than one team';
  end if;

  -- replace this college's draft teams
  update public.students set team_id = null, team_role = null
    where team_id in (select id from public.teams where college_id = p_college and status = 'draft');
  delete from public.teams where college_id = p_college and status = 'draft';

  for t in select * from jsonb_array_elements(p_teams) loop
    insert into public.teams (college_id, number, name) values (p_college, (t ->> 'number')::int, t ->> 'name')
      returning id into tid;
    for m in select * from jsonb_array_elements(t -> 'members') loop
      update public.students set team_id = tid, team_role = m ->> 'role' where id = (m ->> 'student')::uuid;
    end loop;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Only the server functions (service role) may call these.
revoke all on function public.app_store_team_key(uuid, text) from public, anon, authenticated;
revoke all on function public.app_get_team_key(uuid) from public, anon, authenticated;
revoke all on function public.app_delete_team_keys(text) from public, anon, authenticated;
revoke all on function public.app_save_teams(text, jsonb) from public, anon, authenticated;
grant execute on function public.app_store_team_key(uuid, text) to service_role;
grant execute on function public.app_get_team_key(uuid) to service_role;
grant execute on function public.app_delete_team_keys(text) to service_role;
grant execute on function public.app_save_teams(text, jsonb) to service_role;

-- ---------------------------------------------------------------- payment proofs (Storage)
insert into storage.buckets (id, name, public) values ('payment-proofs', 'payment-proofs', false)
  on conflict (id) do nothing;
-- Files are stored as <college_id>/<reference>.<ext>. Staff may view their own college's files.
create policy proofs_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'payment-proofs' and public.can_see_college(split_part(name, '/', 1)));
