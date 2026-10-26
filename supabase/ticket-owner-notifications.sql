-- Notifica a pessoa responsável pelo fluxo quando ela é atribuída ou alterada.
create or replace function public.notify_ticket_workflow()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  recipients uuid[];
  message_title text;
  message_body text;
begin
  if tg_op = 'INSERT' then
    if new.assignee_id is not null then
      insert into public.notifications(recipient_id, ticket_id, title, body)
      values (new.assignee_id, new.id, 'Chamado atribuído', 'Você recebeu o chamado ' || new.ticket_no || '.');
    end if;
    return new;
  end if;

  if old.assignee_id is distinct from new.assignee_id
     or old.workflow_owner_id is distinct from new.workflow_owner_id
     or old.workflow_step is distinct from new.workflow_step then
    select coalesce(array_agg(distinct r.recipient), array[]::uuid[]) into recipients
    from unnest(array[new.assignee_id, new.workflow_owner_id]) as r(recipient)
    where r.recipient is not null and r.recipient is distinct from (select auth.uid());
    message_title := case
      when old.workflow_step is not distinct from new.workflow_step
        and (old.assignee_id is distinct from new.assignee_id or old.workflow_owner_id is distinct from new.workflow_owner_id)
        then 'Chamado atribuído'
      when new.workflow_step = 'orcamento' then 'Ação necessária: orçamento'
      when new.workflow_step = 'financeiro' then 'Orçamento aguardando aprovação'
      when new.workflow_step = 'execucao' then 'Orçamento aprovado'
      when new.workflow_step = 'resolvido' then 'Chamado resolvido'
      else 'Chamado atualizado'
    end;
    message_body := 'Chamado ' || new.ticket_no || ' · ' || replace(new.workflow_step, '_', ' ');
    insert into public.notifications(recipient_id, ticket_id, title, body)
      select recipient, new.id, message_title, message_body from unnest(recipients) recipient where recipient is not null;
  elsif old.finance_decision is distinct from new.finance_decision then
    if new.workflow_owner_id is not null and new.workflow_owner_id is distinct from (select auth.uid()) then
      insert into public.notifications(recipient_id, ticket_id, title, body)
      values (new.workflow_owner_id, new.id,
        case new.finance_decision when 'aprovado' then 'Orçamento aprovado' else 'Orçamento rejeitado' end,
        'Chamado ' || new.ticket_no || case when new.finance_note <> '' then ' · ' || new.finance_note else '' end);
    end if;
  end if;
  return new;
end $$;
