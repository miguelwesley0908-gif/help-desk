-- Permite que apenas administração e coordenação excluam chamados e seus anexos.
drop policy if exists "Admins and coordinators can delete tickets" on public.tickets;
create policy "Admins and coordinators can delete tickets" on public.tickets
for delete to authenticated
using (public.current_app_role() in ('admin', 'coordenador'));

grant delete on public.tickets to authenticated;

drop policy if exists "Admins and coordinators can delete ticket files" on storage.objects;
create policy "Admins and coordinators can delete ticket files" on storage.objects
for delete to authenticated
using (
  bucket_id = 'ticket-files'
  and public.current_app_role() in ('admin', 'coordenador')
);
