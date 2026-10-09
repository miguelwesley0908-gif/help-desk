-- Execute no SQL Editor de um projeto que já recebeu supabase-schema.sql.
-- Pode ser executado novamente sem apagar salas ou reservas.

create extension if not exists btree_gist;

create table if not exists public.meeting_rooms (
  id uuid primary key default gen_random_uuid(),
  office_id uuid not null references public.offices(id),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  capacity integer not null check (capacity between 1 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (office_id, name)
);

create table if not exists public.room_bookings (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.meeting_rooms(id),
  organizer_id uuid not null references public.profiles(id),
  client_name text not null check (char_length(btrim(client_name)) between 1 and 120),
  subject text not null check (char_length(btrim(subject)) between 1 and 160),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint room_bookings_positive_duration check (ends_at > starts_at),
  constraint room_bookings_allowed_duration check (ends_at - starts_at in (
    interval '30 minutes', interval '60 minutes', interval '90 minutes', interval '120 minutes'
  )),
  constraint room_bookings_business_hours check (
    (starts_at at time zone 'America/Sao_Paulo')::time >= time '08:00'
    and (ends_at at time zone 'America/Sao_Paulo')::time <= time '18:00'
    and (starts_at at time zone 'America/Sao_Paulo')::date =
      (ends_at at time zone 'America/Sao_Paulo')::date
    and extract(minute from (starts_at at time zone 'America/Sao_Paulo')) in (0, 30)
    and extract(second from (starts_at at time zone 'America/Sao_Paulo')) = 0
  ),
  constraint room_bookings_no_overlap exclude using gist (
    room_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (canceled_at is null)
);

create index if not exists meeting_rooms_office_id_idx on public.meeting_rooms(office_id);
create index if not exists room_bookings_organizer_id_idx on public.room_bookings(organizer_id);
create index if not exists room_bookings_starts_at_idx on public.room_bookings(starts_at);

alter table public.meeting_rooms enable row level security;
alter table public.room_bookings enable row level security;

revoke all on public.meeting_rooms, public.room_bookings from public, anon, authenticated;

drop policy if exists "Authenticated users can read rooms" on public.meeting_rooms;
create policy "Authenticated users can read rooms" on public.meeting_rooms
for select to authenticated using (public.current_app_role() is not null);

drop policy if exists "Admins can add rooms" on public.meeting_rooms;
create policy "Admins can add rooms" on public.meeting_rooms
for insert to authenticated with check (public.current_app_role() = 'admin');

drop policy if exists "Admins can edit rooms" on public.meeting_rooms;
create policy "Admins can edit rooms" on public.meeting_rooms
for update to authenticated using (public.current_app_role() = 'admin')
with check (public.current_app_role() = 'admin');

drop policy if exists "Owners and admins can read bookings" on public.room_bookings;
create policy "Owners and admins can read bookings" on public.room_bookings
for select to authenticated
using (organizer_id = (select auth.uid()) or public.current_app_role() = 'admin');

drop policy if exists "Users can book active rooms" on public.room_bookings;
create policy "Users can book active rooms" on public.room_bookings
for insert to authenticated with check (
  organizer_id = (select auth.uid())
  and public.current_app_role() in ('colaborador', 'admin')
  and starts_at > now()
  and exists (select 1 from public.meeting_rooms r where r.id = room_id and r.active)
);

drop policy if exists "Owners and admins can cancel future bookings" on public.room_bookings;
create policy "Owners and admins can cancel future bookings" on public.room_bookings
for update to authenticated
using (
  canceled_at is null and starts_at > now()
  and (organizer_id = (select auth.uid()) or public.current_app_role() = 'admin')
)
with check (
  canceled_at is not null
  and (organizer_id = (select auth.uid()) or public.current_app_role() = 'admin')
);

grant select on public.meeting_rooms, public.room_bookings to authenticated;
grant insert (office_id, name, capacity) on public.meeting_rooms to authenticated;
grant update (name, capacity, active) on public.meeting_rooms to authenticated;
grant insert (room_id, organizer_id, client_name, subject, starts_at, ends_at) on public.room_bookings to authenticated;
grant update (canceled_at) on public.room_bookings to authenticated;

-- Availability exposes only occupied room/time intervals, not client or organizer.
create or replace function public.room_busy_slots(p_start timestamptz, p_end timestamptz)
returns table(room_id uuid, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select b.room_id, b.starts_at, b.ends_at
  from public.room_bookings b
  where (select auth.uid()) is not null
    and public.current_app_role() is not null
    and b.canceled_at is null
    and b.starts_at < p_end
    and b.ends_at > p_start
    and p_end > p_start
    and p_end <= p_start + interval '8 days';
$$;

revoke all on function public.room_busy_slots(timestamptz, timestamptz) from public, anon;
grant execute on function public.room_busy_slots(timestamptz, timestamptz) to authenticated;
