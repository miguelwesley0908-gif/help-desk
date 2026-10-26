-- Converte contas atendentes para Financeiro e habilita Financeiro como responsável direto.
update public.profiles
set role = 'financeiro'
where role = 'atendente';

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('colaborador', 'financeiro', 'coordenador', 'admin'));

drop policy if exists "Users can open permitted tickets" on public.tickets;
create policy "Users can open permitted tickets" on public.tickets for insert to authenticated
with check (
  requester_id = (select auth.uid())
  and (
    (public.current_app_role() = 'colaborador' and office_id = public.current_app_office())
    or public.current_app_role() in ('financeiro', 'admin', 'coordenador')
  )
  and assignee_id is not null
  and workflow_owner_id = assignee_id
  and exists (
    select 1 from public.profiles p
    where p.id = assignee_id and p.role in ('financeiro', 'coordenador', 'admin')
  )
);

drop policy if exists "Users can book active rooms" on public.room_bookings;
create policy "Users can book active rooms" on public.room_bookings for insert to authenticated
with check (
  organizer_id = (select auth.uid())
  and public.current_app_role() in ('colaborador', 'financeiro', 'coordenador', 'admin')
  and starts_at > now()
  and exists (select 1 from public.meeting_rooms r where r.id = room_id and r.active)
);
