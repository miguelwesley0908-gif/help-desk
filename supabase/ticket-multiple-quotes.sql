
-- Orçamentos múltiplos: cada opção é um anexo com valor próprio.
alter table public.ticket_attachments add column if not exists quote_amount numeric(12,2);
alter table public.ticket_attachments drop constraint if exists ticket_attachments_quote_amount_check;
alter table public.ticket_attachments add constraint ticket_attachments_quote_amount_check
  check (quote_amount is null or quote_amount > 0);
alter table public.tickets add column if not exists approved_quote_attachment_id uuid
  references public.ticket_attachments(id) on delete set null;

-- Mantém os orçamentos existentes como a opção única previamente cadastrada.
with ranked_quotes as (
  select a.id, a.ticket_id, row_number() over (partition by a.ticket_id order by a.created_at, a.id) as position
  from public.ticket_attachments a
)
update public.ticket_attachments a
set quote_amount = t.budget_amount
from public.tickets t, ranked_quotes q
where q.id = a.id and q.ticket_id = t.id and q.position = 1
  and t.budget_amount is not null and a.quote_amount is null;

update public.tickets t
set approved_quote_attachment_id = (
  select a.id from public.ticket_attachments a
  where a.ticket_id = t.id and a.quote_amount = t.budget_amount
  order by a.created_at, a.id limit 1
)
where t.finance_decision = 'aprovado' and t.budget_amount is not null
  and t.approved_quote_attachment_id is null;

create or replace function public.enforce_ticket_workflow()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  actor_role text := public.current_app_role();
  actor_id uuid := (select auth.uid());
begin
  if tg_op = 'UPDATE' and actor_role not in ('admin', 'coordenador') then
    if old.priority is distinct from new.priority then
      raise exception 'Somente administração ou coordenação pode alterar a prioridade.';
    end if;
    if old.workflow_step = new.workflow_step and (old.status is distinct from new.status
      or old.budget_amount is distinct from new.budget_amount
      or old.finance_decision is distinct from new.finance_decision
      or old.finance_note is distinct from new.finance_note) then
      raise exception 'Use as ações da etapa atual para atualizar o fluxo.';
    end if;
    if actor_role = 'financeiro' and (old.workflow_owner_id is distinct from new.workflow_owner_id
      or old.financial_assignee_id is distinct from new.financial_assignee_id
      or ((old.budget_amount is distinct from new.budget_amount or old.approved_quote_attachment_id is distinct from new.approved_quote_attachment_id)
        and not (old.workflow_step = 'financeiro' and new.workflow_step = 'execucao'
          and actor_id = old.assignee_id and new.finance_decision = 'aprovado'))) then
      raise exception 'O Financeiro só pode alterar o orçamento ao aprovar uma opção cadastrada.';
    end if;
  end if;

  if tg_op = 'UPDATE' and (old.workflow_owner_id is distinct from new.workflow_owner_id
      or old.financial_assignee_id is distinct from new.financial_assignee_id)
     and actor_role not in ('admin', 'coordenador') then
    raise exception 'Somente administração ou coordenação pode alterar os responsáveis.';
  end if;

  if tg_op = 'UPDATE' and old.assignee_id is distinct from new.assignee_id
     and actor_role not in ('admin', 'coordenador')
     and not (old.workflow_step = 'orcamento' and new.workflow_step = 'financeiro' and actor_id = old.workflow_owner_id
       and new.assignee_id = old.financial_assignee_id)
     and not (old.workflow_step = 'financeiro' and new.workflow_step in ('execucao', 'orcamento') and actor_id = old.assignee_id
       and new.assignee_id = old.workflow_owner_id) then
    raise exception 'Somente administração ou coordenação pode reatribuir chamados fora das transições do fluxo.';
  end if;

  if tg_op = 'UPDATE' and old.workflow_step is distinct from new.workflow_step then
    if old.workflow_step = 'triagem' and new.workflow_step = 'orcamento' then
      if actor_id is distinct from old.workflow_owner_id and actor_role not in ('admin', 'coordenador') then
        raise exception 'Somente Andreza ou a administração pode iniciar o contato do orçamento.';
      end if;
      if new.workflow_owner_id is null or new.assignee_id is distinct from new.workflow_owner_id then
        raise exception 'Atribua Andreza antes de iniciar o contato.';
      end if;
    elsif old.workflow_step = 'orcamento' and new.workflow_step = 'financeiro' then
      if actor_id is distinct from old.workflow_owner_id and actor_role not in ('admin', 'coordenador') then
        raise exception 'Somente Andreza pode encaminhar o orçamento.';
      end if;
      if new.financial_assignee_id is null or new.assignee_id is distinct from new.financial_assignee_id
         or not exists (select 1 from public.ticket_attachments a where a.ticket_id = old.id and a.quote_amount is not null) then
        raise exception 'Informe o Financeiro e cadastre ao menos um orçamento com valor e arquivo antes de encaminhar.';
      end if;
    elsif old.workflow_step = 'financeiro' and new.workflow_step in ('execucao', 'orcamento') then
      if actor_role not in ('admin', 'coordenador') and actor_id is distinct from old.assignee_id then
        raise exception 'Somente o Financeiro responsável pode decidir o orçamento.';
      end if;
      if (new.workflow_step = 'execucao' and (new.finance_decision <> 'aprovado' or new.assignee_id is distinct from new.workflow_owner_id
           or new.approved_quote_attachment_id is null or not exists (
             select 1 from public.ticket_attachments a
             where a.id = new.approved_quote_attachment_id and a.ticket_id = old.id and a.quote_amount = new.budget_amount
           )))
         or (new.workflow_step = 'orcamento' and (new.finance_decision <> 'rejeitado' or new.assignee_id is distinct from new.workflow_owner_id or char_length(trim(new.finance_note)) = 0)) then
        raise exception 'Registre a decisão e devolva o chamado à Andreza.';
      end if;
    elsif old.workflow_step = 'execucao' and new.workflow_step = 'encerrado' then
      if actor_id is distinct from old.workflow_owner_id and actor_role not in ('admin', 'coordenador') then
        raise exception 'Somente a pessoa responsável pelo fluxo pode confirmar a conclusão do serviço.';
      end if;
    elsif old.workflow_step = 'resolvido' and new.workflow_step = 'encerrado' then
      if actor_id is not null and actor_role not in ('admin', 'coordenador') then
        raise exception 'Somente administração ou coordenação pode normalizar um chamado concluído.';
      end if;
    else
      raise exception 'Transição de etapa inválida.';
    end if;
  end if;
  return new;
end $$;


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
      when new.workflow_step = 'financeiro' then 'Orçamentos aguardando aprovação'
      when new.workflow_step = 'execucao' then 'Orçamento aprovado'
      when new.workflow_step = 'encerrado' then 'Chamado encerrado'
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



drop policy if exists "Assigned staff can add ticket attachments" on public.ticket_attachments;
create policy "Assigned staff can add ticket attachments" on public.ticket_attachments for insert to authenticated
with check (
  uploader_id = (select auth.uid())
  and exists (
    select 1 from public.tickets t
    where t.id = ticket_id
      and file_path like t.id::text || '/%'
      and (t.workflow_owner_id = (select auth.uid()) or t.assignee_id = (select auth.uid()) or public.current_app_role() in ('admin', 'coordenador'))
      and (quote_amount is null or (t.workflow_step = 'orcamento' and (t.workflow_owner_id = (select auth.uid()) or public.current_app_role() in ('admin', 'coordenador'))))
  )
);

grant insert (ticket_id, uploader_id, file_name, file_path, mime_type, file_size, quote_amount) on public.ticket_attachments to authenticated;
grant update (status, priority, assignee_id, workflow_owner_id, financial_assignee_id, workflow_step, budget_amount, finance_decision, finance_note, approved_quote_attachment_id) on public.tickets to authenticated;
