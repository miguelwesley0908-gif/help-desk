-- Hekp Gesk: initial shared database schema for Supabase.
-- Run this once in the Supabase SQL Editor before creating user profiles.

create extension if not exists pgcrypto;

create table if not exists public.offices (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  city text not null,
  address text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null check (role in ('colaborador', 'financeiro', 'coordenador', 'admin')),
  office_id uuid not null references public.offices(id),
  created_at timestamptz not null default now()
);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_no bigint generated always as identity unique,
  title text not null check (char_length(title) between 1 and 90),
  description text not null check (char_length(description) > 0),
  category text not null check (category in ('TI', 'Infraestrutura', 'Financeiro')),
  priority text not null default 'media' check (priority in ('baixa', 'media', 'alta', 'urgente')),
  status text not null default 'aberto' check (status in ('aberto', 'andamento', 'aguardando', 'resolvido', 'encerrado')),
  office_id uuid not null references public.offices(id),
  location text,
  requester_id uuid references public.profiles(id) on delete set null,
  assignee_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ticket_comments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);

create table if not exists public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists tickets_requester_id_idx on public.tickets(requester_id);
create index if not exists tickets_office_id_idx on public.tickets(office_id);
create index if not exists tickets_assignee_id_idx on public.tickets(assignee_id);
create index if not exists tickets_updated_at_idx on public.tickets(updated_at desc);
create index if not exists ticket_comments_ticket_id_idx on public.ticket_comments(ticket_id);
create index if not exists ticket_events_ticket_id_idx on public.ticket_events(ticket_id);

create or replace function public.current_app_role()
returns text
language sql stable security definer
set search_path = ''
as $$ select role from public.profiles where id = (select auth.uid()) $$;

create or replace function public.current_app_office()
returns uuid
language sql stable security definer
set search_path = ''
as $$ select office_id from public.profiles where id = (select auth.uid()) $$;

revoke all on function public.current_app_role() from public, anon;
revoke all on function public.current_app_office() from public, anon;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.current_app_office() to authenticated;

create or replace function public.set_ticket_updated_at()
returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at = now(); return new; end $$;

create or replace function public.record_ticket_changes()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.status is distinct from new.status then
    insert into public.ticket_events(ticket_id, actor_id, body)
    values (new.id, (select auth.uid()), 'Status: ' || old.status || ' → ' || new.status);
  end if;
  if old.priority is distinct from new.priority then
    insert into public.ticket_events(ticket_id, actor_id, body)
    values (new.id, (select auth.uid()), 'Prioridade: ' || old.priority || ' → ' || new.priority);
  end if;
  if old.assignee_id is distinct from new.assignee_id then
    insert into public.ticket_events(ticket_id, actor_id, body)
    values (new.id, (select auth.uid()), 'Responsável atualizado.');
  end if;
  return new;
end $$;

create or replace function public.prevent_ticket_reassignment_by_assignee()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.assignee_id is distinct from new.assignee_id
     and public.current_app_role() not in ('admin', 'coordenador') then
    raise exception 'Somente a administração ou coordenação pode reatribuir chamados.';
  end if;
  return new;
end $$;

create or replace function public.touch_ticket_from_comment()
returns trigger language plpgsql security definer set search_path = ''
as $$ begin update public.tickets set updated_at = now() where id = new.ticket_id; return new; end $$;

drop trigger if exists tickets_set_updated_at on public.tickets;
create trigger tickets_set_updated_at before update on public.tickets
for each row execute function public.set_ticket_updated_at();
drop trigger if exists tickets_record_changes on public.tickets;
create trigger tickets_record_changes after update on public.tickets
for each row execute function public.record_ticket_changes();
drop trigger if exists tickets_reassignment_guard on public.tickets;
create trigger tickets_reassignment_guard before update on public.tickets
for each row execute function public.prevent_ticket_reassignment_by_assignee();
drop trigger if exists comments_touch_ticket on public.ticket_comments;
create trigger comments_touch_ticket after insert on public.ticket_comments
for each row execute function public.touch_ticket_from_comment();

alter table public.offices enable row level security;
alter table public.profiles enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_comments enable row level security;
alter table public.ticket_events enable row level security;

revoke all on public.offices, public.profiles, public.tickets, public.ticket_comments, public.ticket_events from public, anon, authenticated;

drop policy if exists "Signed-in users can read offices" on public.offices;
create policy "Signed-in users can read offices" on public.offices for select to authenticated using (true);
drop policy if exists "Admins can add offices" on public.offices;
create policy "Admins can add offices" on public.offices for insert to authenticated with check (public.current_app_role() in ('admin', 'coordenador'));
drop policy if exists "Admins can edit offices" on public.offices;
create policy "Admins can edit offices" on public.offices for update to authenticated using (public.current_app_role() in ('admin', 'coordenador')) with check (public.current_app_role() in ('admin', 'coordenador'));

-- Names, roles, and office assignments are visible to signed-in teammates; emails stay in Auth.
drop policy if exists "Signed-in users can read profiles" on public.profiles;
create policy "Signed-in users can read profiles" on public.profiles for select to authenticated using (true);

drop policy if exists "Users can read permitted tickets" on public.tickets;
create policy "Users can read permitted tickets" on public.tickets for select to authenticated
using (
  requester_id = (select auth.uid())
  or assignee_id = (select auth.uid())
  or public.current_app_role() in ('admin', 'coordenador')
);
drop policy if exists "Users can open permitted tickets" on public.tickets;
create policy "Users can open permitted tickets" on public.tickets for insert to authenticated
with check (
  requester_id = (select auth.uid()) and (
    (public.current_app_role() = 'colaborador' and office_id = public.current_app_office()) or
    public.current_app_role() in ('financeiro', 'admin', 'coordenador')
  )
);
drop policy if exists "Staff can triage tickets" on public.tickets;
create policy "Staff can triage tickets" on public.tickets for update to authenticated
using (public.current_app_role() in ('admin', 'coordenador') or assignee_id = (select auth.uid()))
with check (public.current_app_role() in ('admin', 'coordenador') or assignee_id = (select auth.uid()));

drop policy if exists "Users can read comments on permitted tickets" on public.ticket_comments;
create policy "Users can read comments on permitted tickets" on public.ticket_comments for select to authenticated
using (exists (select 1 from public.tickets t where t.id = ticket_id));
drop policy if exists "Users can comment on permitted tickets" on public.ticket_comments;
create policy "Users can comment on permitted tickets" on public.ticket_comments for insert to authenticated
with check (author_id = (select auth.uid()) and exists (
  select 1 from public.tickets t where t.id = ticket_id
    and (t.assignee_id = (select auth.uid()) or public.current_app_role() in ('admin', 'coordenador'))
));

drop policy if exists "Users can read events on permitted tickets" on public.ticket_events;
create policy "Users can read events on permitted tickets" on public.ticket_events for select to authenticated
using (exists (select 1 from public.tickets t where t.id = ticket_id));

grant select on public.offices, public.profiles, public.tickets, public.ticket_comments, public.ticket_events to authenticated;
grant insert (title, description, category, priority, office_id, location, requester_id, assignee_id) on public.tickets to authenticated;
grant insert (ticket_id, author_id, body) on public.ticket_comments to authenticated;
grant insert (name, city, address) on public.offices to authenticated;
grant update (status, priority, assignee_id) on public.tickets to authenticated;
grant update (name, city, address) on public.offices to authenticated;
grant usage, select on all sequences in schema public to authenticated;

insert into public.offices(name, city, address) values
  ('São Paulo — Paulista', 'São Paulo', 'Av. Paulista, 1100 · 12º andar'),
  ('Rio — Centro', 'Rio de Janeiro', 'Rua da Assembleia, 10 · 5º andar'),
  ('BH — Savassi', 'Belo Horizonte', 'Rua Fernandes Tourinho, 200'),
  ('Recife — Boa Viagem', 'Recife', 'Av. Boa Viagem, 500 · sala 801')
on conflict (name) do nothing;
