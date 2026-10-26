-- Workflow de orçamento, aprovação financeira, anexos privados e notificações internas.
-- Execute depois de supabase-schema.sql e das migrações já usadas pelo projeto.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('colaborador', 'financeiro', 'coordenador', 'admin'));

alter table public.tickets add column if not exists workflow_owner_id uuid references public.profiles(id) on delete set null;
alter table public.tickets add column if not exists financial_assignee_id uuid references public.profiles(id) on delete set null;
alter table public.tickets add column if not exists workflow_step text not null default 'triagem';
alter table public.tickets add column if not exists budget_amount numeric(12,2);
alter table public.tickets add column if not exists finance_decision text not null default 'pendente';
alter table public.tickets add column if not exists finance_note text not null default '';
alter table public.tickets drop constraint if exists tickets_workflow_step_check;
alter table public.tickets add constraint tickets_workflow_step_check
  check (workflow_step in ('triagem', 'orcamento', 'financeiro', 'execucao', 'resolvido'));
alter table public.tickets drop constraint if exists tickets_finance_decision_check;
alter table public.tickets add constraint tickets_finance_decision_check
  check (finance_decision in ('pendente', 'aprovado', 'rejeitado'));
alter table public.tickets drop constraint if exists tickets_budget_amount_check;
alter table public.tickets add constraint tickets_budget_amount_check
  check (budget_amount is null or budget_amount > 0);

create index if not exists tickets_workflow_owner_idx on public.tickets(workflow_owner_id);
create index if not exists tickets_financial_assignee_idx on public.tickets(financial_assignee_id);

create table if not exists public.ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  uploader_id uuid references public.profiles(id) on delete set null,
  file_name text not null check (char_length(file_name) between 1 and 255),
  file_path text not null unique,
  mime_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 10485760),
  created_at timestamptz not null default now()
);
create index if not exists ticket_attachments_ticket_idx on public.ticket_attachments(ticket_id, created_at);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists notifications_recipient_created_idx on public.notifications(recipient_id, created_at desc);

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
      or old.budget_amount is distinct from new.budget_amount) then
      raise exception 'O Financeiro pode registrar a decisão, sem alterar responsáveis ou valor do orçamento.';
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
         or new.budget_amount is null or not exists (select 1 from public.ticket_attachments a where a.ticket_id = old.id) then
        raise exception 'Informe o Financeiro, o valor e anexe o orçamento antes de encaminhar.';
      end if;
    elsif old.workflow_step = 'financeiro' and new.workflow_step in ('execucao', 'orcamento') then
      if actor_role not in ('admin', 'coordenador') and actor_id is distinct from old.assignee_id then
        raise exception 'Somente o Financeiro responsável pode decidir o orçamento.';
      end if;
      if (new.workflow_step = 'execucao' and (new.finance_decision <> 'aprovado' or new.assignee_id is distinct from new.workflow_owner_id))
         or (new.workflow_step = 'orcamento' and (new.finance_decision <> 'rejeitado' or new.assignee_id is distinct from new.workflow_owner_id or char_length(trim(new.finance_note)) = 0)) then
        raise exception 'Registre a decisão e devolva o chamado à Andreza.';
      end if;
    elsif old.workflow_step = 'execucao' and new.workflow_step = 'resolvido' then
      if actor_id is distinct from old.workflow_owner_id and actor_role not in ('admin', 'coordenador') then
        raise exception 'Somente Andreza pode confirmar a conclusão do serviço.';
      end if;
    else
      raise exception 'Transição de etapa inválida.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists tickets_workflow_guard on public.tickets;
create trigger tickets_workflow_guard before update on public.tickets
for each row execute function public.enforce_ticket_workflow();
drop trigger if exists tickets_reassignment_guard on public.tickets;

create or replace function public.record_ticket_changes()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.status is distinct from new.status then
    insert into public.ticket_events(ticket_id, actor_id, body)
    values (new.id, (select auth.uid()), 'Status: ' || old.status || ' → ' || new.status);
  end if;
  if old.workflow_step is distinct from new.workflow_step then
    insert into public.ticket_events(ticket_id, actor_id, body)
    values (new.id, (select auth.uid()), 'Etapa do fluxo: ' || old.workflow_step || ' → ' || new.workflow_step);
  end if;
  if old.finance_decision is distinct from new.finance_decision then
    insert into public.ticket_events(ticket_id, actor_id, body)
    values (new.id, (select auth.uid()), 'Decisão financeira: ' || new.finance_decision || case when new.finance_note <> '' then ' · ' || new.finance_note else '' end);
  end if;
  if old.budget_amount is distinct from new.budget_amount and new.budget_amount is not null then
    insert into public.ticket_events(ticket_id, actor_id, body)
    values (new.id, (select auth.uid()), 'Orçamento registrado: R$ ' || to_char(new.budget_amount, 'FM999999990.00'));
  end if;
  if old.priority is distinct from new.priority then
    insert into public.ticket_events(ticket_id, actor_id, body)
    values (new.id, (select auth.uid()), 'Prioridade: ' || old.priority || ' → ' || new.priority);
  end if;
  if old.assignee_id is distinct from new.assignee_id then
    insert into public.ticket_events(ticket_id, actor_id, body)
    values (new.id, (select auth.uid()), 'Responsável atualizado.');
  end if;
  if old.workflow_owner_id is distinct from new.workflow_owner_id then
    insert into public.ticket_events(ticket_id, actor_id, body)
    values (new.id, (select auth.uid()), 'Responsável contínua do fluxo atualizado.');
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

drop trigger if exists tickets_workflow_notifications on public.tickets;
create trigger tickets_workflow_notifications after insert or update on public.tickets
for each row execute function public.notify_ticket_workflow();

alter table public.ticket_attachments enable row level security;
alter table public.notifications enable row level security;
revoke all on public.ticket_attachments, public.notifications from public, anon, authenticated;

drop policy if exists "Team can read ticket attachments" on public.ticket_attachments;
create policy "Team can read ticket attachments" on public.ticket_attachments for select to authenticated
using (exists (select 1 from public.tickets t where t.id = ticket_id));
drop policy if exists "Assigned staff can add ticket attachments" on public.ticket_attachments;
create policy "Assigned staff can add ticket attachments" on public.ticket_attachments for insert to authenticated
with check (uploader_id = (select auth.uid()) and exists (
  select 1 from public.tickets t where t.id = ticket_id
  and file_path like t.id::text || '/%'
  and (t.workflow_owner_id = (select auth.uid()) or t.assignee_id = (select auth.uid()) or public.current_app_role() in ('admin', 'coordenador'))
));

drop policy if exists "Users can read own notifications" on public.notifications;
create policy "Users can read own notifications" on public.notifications for select to authenticated
using (recipient_id = (select auth.uid()));
drop policy if exists "Users can mark own notifications read" on public.notifications;
create policy "Users can mark own notifications read" on public.notifications for update to authenticated
using (recipient_id = (select auth.uid())) with check (recipient_id = (select auth.uid()));

drop policy if exists "Users can read permitted tickets" on public.tickets;
create policy "Users can read permitted tickets" on public.tickets for select to authenticated
using (requester_id = (select auth.uid()) or assignee_id = (select auth.uid()) or workflow_owner_id = (select auth.uid())
  or public.current_app_role() in ('admin', 'coordenador'));
drop policy if exists "Users can open permitted tickets" on public.tickets;
create policy "Users can open permitted tickets" on public.tickets for insert to authenticated
with check (requester_id = (select auth.uid()) and (
  (public.current_app_role() = 'colaborador' and office_id = public.current_app_office()) or
  public.current_app_role() in ('financeiro', 'admin', 'coordenador')
) and assignee_id is not null and workflow_owner_id = assignee_id and exists (
  select 1 from public.profiles p where p.id = assignee_id and p.role in ('financeiro', 'coordenador', 'admin')
));
drop policy if exists "Staff can triage tickets" on public.tickets;
create policy "Staff can triage tickets" on public.tickets for update to authenticated
using (public.current_app_role() in ('admin', 'coordenador') or assignee_id = (select auth.uid()) or workflow_owner_id = (select auth.uid()))
with check (public.current_app_role() in ('admin', 'coordenador') or assignee_id = (select auth.uid()) or workflow_owner_id = (select auth.uid())
  or (public.current_app_role() = 'financeiro' and workflow_step in ('execucao', 'orcamento') and finance_decision in ('aprovado', 'rejeitado')));

drop policy if exists "Users can comment on permitted tickets" on public.ticket_comments;
create policy "Users can comment on permitted tickets" on public.ticket_comments for insert to authenticated
with check (author_id = (select auth.uid()) and exists (
  select 1 from public.tickets t where t.id = ticket_id
  and (t.assignee_id = (select auth.uid()) or t.workflow_owner_id = (select auth.uid()) or public.current_app_role() in ('admin', 'coordenador'))
));

grant select on public.ticket_attachments, public.notifications to authenticated;
grant insert (ticket_id, uploader_id, file_name, file_path, mime_type, file_size) on public.ticket_attachments to authenticated;
grant insert (title, description, category, priority, office_id, location, requester_id, assignee_id, workflow_owner_id) on public.tickets to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant update (status, priority, assignee_id, workflow_owner_id, financial_assignee_id, workflow_step, budget_amount, finance_decision, finance_note) on public.tickets to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ticket-files', 'ticket-files', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "Team can read ticket files" on storage.objects;
create policy "Team can read ticket files" on storage.objects for select to authenticated
using (bucket_id = 'ticket-files' and exists (
  select 1 from public.tickets t where t.id::text = (storage.foldername(name))[1]
));
drop policy if exists "Assigned staff can upload ticket files" on storage.objects;
create policy "Assigned staff can upload ticket files" on storage.objects for insert to authenticated
with check (bucket_id = 'ticket-files' and exists (
  select 1 from public.tickets t where t.id::text = (storage.foldername(name))[1]
  and (t.workflow_owner_id = (select auth.uid()) or t.assignee_id = (select auth.uid()) or public.current_app_role() in ('admin', 'coordenador'))
));
