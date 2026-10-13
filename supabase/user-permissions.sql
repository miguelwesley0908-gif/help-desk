-- Atualiza os perfis e as permissões para acesso por responsável.
-- Seguro para executar em projetos existentes; não altera os dados cadastrados.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('colaborador', 'atendente', 'coordenador', 'admin'));

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

drop trigger if exists tickets_reassignment_guard on public.tickets;
create trigger tickets_reassignment_guard before update on public.tickets
for each row execute function public.prevent_ticket_reassignment_by_assignee();

drop policy if exists "Admins can add offices" on public.offices;
create policy "Admins can add offices" on public.offices for insert to authenticated
with check (public.current_app_role() in ('admin', 'coordenador'));
drop policy if exists "Admins can edit offices" on public.offices;
create policy "Admins can edit offices" on public.offices for update to authenticated
using (public.current_app_role() in ('admin', 'coordenador'))
with check (public.current_app_role() in ('admin', 'coordenador'));

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
    public.current_app_role() in ('atendente', 'coordenador', 'admin')
  )
);
drop policy if exists "Staff can triage tickets" on public.tickets;
create policy "Staff can triage tickets" on public.tickets for update to authenticated
using (public.current_app_role() in ('admin', 'coordenador') or assignee_id = (select auth.uid()))
with check (public.current_app_role() in ('admin', 'coordenador') or assignee_id = (select auth.uid()));

drop policy if exists "Users can comment on permitted tickets" on public.ticket_comments;
create policy "Users can comment on permitted tickets" on public.ticket_comments for insert to authenticated
with check (author_id = (select auth.uid()) and exists (
  select 1 from public.tickets t where t.id = ticket_id
    and (t.assignee_id = (select auth.uid()) or public.current_app_role() in ('admin', 'coordenador'))
));

drop policy if exists "Admins can add rooms" on public.meeting_rooms;
create policy "Admins can add rooms" on public.meeting_rooms for insert to authenticated
with check (public.current_app_role() in ('admin', 'coordenador'));
drop policy if exists "Admins can edit rooms" on public.meeting_rooms;
create policy "Admins can edit rooms" on public.meeting_rooms for update to authenticated
using (public.current_app_role() in ('admin', 'coordenador'))
with check (public.current_app_role() in ('admin', 'coordenador'));

drop policy if exists "Owners and admins can read bookings" on public.room_bookings;
drop policy if exists "Authenticated users can read bookings" on public.room_bookings;
create policy "Authenticated users can read bookings" on public.room_bookings for select to authenticated
using (public.current_app_role() is not null);
drop policy if exists "Users can book active rooms" on public.room_bookings;
create policy "Users can book active rooms" on public.room_bookings for insert to authenticated
with check (
  organizer_id = (select auth.uid())
  and public.current_app_role() in ('colaborador', 'atendente', 'coordenador', 'admin')
  and starts_at > now()
  and exists (select 1 from public.meeting_rooms r where r.id = room_id and r.active)
);
drop policy if exists "Owners and admins can cancel future bookings" on public.room_bookings;
create policy "Owners and admins can cancel future bookings" on public.room_bookings for update to authenticated
using (
  canceled_at is null and starts_at > now()
  and (organizer_id = (select auth.uid()) or public.current_app_role() in ('admin', 'coordenador'))
)
with check (
  starts_at > now()
  and (organizer_id = (select auth.uid()) or public.current_app_role() in ('admin', 'coordenador'))
  and (canceled_at is not null or exists (
    select 1 from public.meeting_rooms r where r.id = room_id and r.active
  ))
);

grant update (room_id, client_name, subject, starts_at, ends_at, canceled_at)
on public.room_bookings to authenticated;
