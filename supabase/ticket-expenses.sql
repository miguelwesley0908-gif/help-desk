-- Valor efetivamente pago por chamado.
-- Execute depois de supabase/ticket-workflow.sql.
-- Um registro por chamado; o valor só é editável pelo Financeiro responsável,
-- após aprovação do orçamento e início da execução.

create table public.ticket_expenses (
  ticket_id uuid primary key references public.tickets(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  paid_at date not null default current_date,
  recorded_by uuid references public.profiles(id) on delete set null,
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ticket_expenses_recorded_by_idx on public.ticket_expenses (recorded_by);

alter table public.ticket_expenses enable row level security;
revoke all on public.ticket_expenses from public, anon, authenticated;
grant select on public.ticket_expenses to authenticated;
grant insert (ticket_id, amount, paid_at, recorded_by) on public.ticket_expenses to authenticated;
grant update (amount, paid_at, updated_at) on public.ticket_expenses to authenticated;

create policy "Financeiro can read ticket expenses"
on public.ticket_expenses
for select to authenticated
using (public.current_app_role() = 'financeiro');

create policy "Assigned Financeiro can record ticket expenses"
on public.ticket_expenses
for insert to authenticated
with check (
  public.current_app_role() = 'financeiro'
  and recorded_by = (select auth.uid())
  and exists (
    select 1
    from public.tickets t
    where t.id = ticket_expenses.ticket_id
      and t.financial_assignee_id = (select auth.uid())
      and t.finance_decision = 'aprovado'
      and t.workflow_step in ('execucao', 'resolvido')
  )
);

create policy "Assigned Financeiro can update ticket expenses"
on public.ticket_expenses
for update to authenticated
using (
  public.current_app_role() = 'financeiro'
  and exists (
    select 1
    from public.tickets t
    where t.id = ticket_expenses.ticket_id
      and t.financial_assignee_id = (select auth.uid())
      and t.finance_decision = 'aprovado'
      and t.workflow_step in ('execucao', 'resolvido')
  )
)
with check (
  public.current_app_role() = 'financeiro'
  and exists (
    select 1
    from public.tickets t
    where t.id = ticket_expenses.ticket_id
      and t.financial_assignee_id = (select auth.uid())
      and t.finance_decision = 'aprovado'
      and t.workflow_step in ('execucao', 'resolvido')
  )
);
