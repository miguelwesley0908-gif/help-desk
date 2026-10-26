-- Permite que o perfil Financeiro acompanhe todos os chamados até a conclusão.
-- Comentários, eventos e arquivos herdam a leitura da visibilidade do chamado.
-- As políticas de INSERT e UPDATE permanecem restritas às regras atuais do fluxo.

alter policy "Users can read permitted tickets"
on public.tickets
using (
  requester_id = (select auth.uid())
  or assignee_id = (select auth.uid())
  or workflow_owner_id = (select auth.uid())
  or (select public.current_app_role()) in ('admin', 'coordenador', 'financeiro')
);
