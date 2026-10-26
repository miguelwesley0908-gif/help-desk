-- Exibe a atribuição na abertura do chamado e grava o responsável contínuo do fluxo.
-- Execute depois de supabase/ticket-workflow.sql.

drop policy if exists "Users can open permitted tickets" on public.tickets;
create policy "Users can open permitted tickets" on public.tickets for insert to authenticated
with check (
  requester_id = (select auth.uid())
  and (
    (public.current_app_role() = 'colaborador' and office_id = public.current_app_office())
    or public.current_app_role() in ('atendente', 'financeiro', 'admin', 'coordenador')
  )
  and assignee_id is not null
  and workflow_owner_id = assignee_id
  and exists (
    select 1 from public.profiles p
    where p.id = assignee_id and p.role in ('atendente', 'coordenador', 'admin')
  )
);

grant insert (assignee_id, workflow_owner_id) on public.tickets to authenticated;
